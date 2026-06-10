package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const version = "2.2.0"

// ── CLI ──
var (
	cliPort    = flag.Int("port", 7899, "监听端口")
	cliCache   = flag.Int("cache", 5, "缓存时间(分钟)")
	cliRate    = flag.Int("rate", 30, "限流速率(req/s)")
	cliBurst   = flag.Int("burst", 60, "限流突发容量")
	cliTimeout = flag.Int("timeout", 12, "搜索引擎请求超时(秒)")
	cliVersion = flag.Bool("version", false, "显示版本")
	cliStop    = flag.Bool("stop", false, "停止后台运行的实例")
	cliStart   = flag.Bool("start", false, "后台启动（nohup模式）")
	cliStatus  = flag.Bool("status", false, "查看运行状态")
	cliRestart = flag.Bool("restart", false, "重启后台实例")
)

var pidFile = "/tmp/metona-search-proxy.pid"

// ── 统计 ──
type statsData struct {
	ReqTotal   atomic.Int64
	ReqRate    atomic.Int64   // 被限流的
	CacheHit   atomic.Int64
	EngineOK   [4]atomic.Int64 // google/bing/baidu/ddg 成功
	EngineFail [4]atomic.Int64 // google/bing/baidu/ddg 失败
	StartTime  time.Time
}

var stats = &statsData{StartTime: time.Now()}

// ── 限流器 ──
type RateLimiter struct {
	tokens   atomic.Int64
	capacity int64
	rate     int64
	lastFill atomic.Int64
}

func newRateLimiter(rate, cap int64) *RateLimiter {
	rl := &RateLimiter{rate: rate, capacity: cap}
	rl.tokens.Store(cap)
	rl.lastFill.Store(time.Now().UnixNano())
	return rl
}

func (rl *RateLimiter) Allow() bool {
	now := time.Now().UnixNano()
	last := rl.lastFill.Load()
	elapsed := float64(now-last) / 1e9
	newTokens := int64(elapsed * float64(rl.rate))
	if newTokens > 0 {
		rl.lastFill.Store(now)
		for {
			current := rl.tokens.Load()
			next := current + newTokens
			if next > rl.capacity {
				next = rl.capacity
			}
			if rl.tokens.CompareAndSwap(current, next) {
				break
			}
		}
	}
	for {
		current := rl.tokens.Load()
		if current <= 0 {
			return false
		}
		if rl.tokens.CompareAndSwap(current, current-1) {
			return true
		}
	}
}

// ── 缓存 ──
var cache sync.Map

type cacheEntry struct {
	Results   []Result
	ExpiresAt int64
}

var cacheSize atomic.Int64

func cleanCacheLoop(interval time.Duration) {
	for {
		time.Sleep(interval)
		now := time.Now().Unix()
		count := 0
		cache.Range(func(key, value any) bool {
			ce := value.(cacheEntry)
			if now >= ce.ExpiresAt {
				cache.Delete(key)
				count++
			}
			return true
		})
		if count > 0 {
			log.Printf("cache cleaned: %d entries removed", count)
		}
	}
}

// ── 正则预编译（全局，避免每次搜索重新编译）──
var (
	reGoogleBlock = regexp.MustCompile(`<(?:div|li)[^>]*class="[^"]*(?:Gx5Zad|g|kvH3mc)[^"]*"[^>]*>([\s\S]*?)</(?:div|li)>`)
	reGoogleTitle = regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)</h3>`)
	reGoogleSnip  = regexp.MustCompile(`<(?:div|span)[^>]*(?:data-sncf|class="[^"]*(?:VwiC3b|st|lWMagT)[^"]*")[^>]*>([\s\S]*?)</(?:div|span)>`)

	reBingBlock = regexp.MustCompile(`<li class="b_algo"[^>]*>([\s\S]*?)</li>`)
	reBingTitle = regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>([\s\S]*?)</a>`)
	reBingSnip  = regexp.MustCompile(`<p[^>]*>([\s\S]*?)</p>`)

	reDDGLink = regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>([\s\S]*?)</a>`)

	reBaiduBlock = regexp.MustCompile(`<div class="result[^"]*"[^>]*>([\s\S]*?)</div>\s*(?:<div class="result|$)`)
	reBaiduTitle = regexp.MustCompile(`<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>`)
	reBaiduSnip  = regexp.MustCompile(`<div class="c-abstract"[^>]*>([\s\S]*?)</div>`)
	reBaiduDURL  = regexp.MustCompile(`data-url="(https?://[^"]*)"`)

	reHTMLTags = regexp.MustCompile(`<[^>]+>`)
)

type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Engine  string `json:"engine"`
}

type SearchResp struct {
	Success   bool     `json:"success"`
	Query     string   `json:"query"`
	Total     int      `json:"total"`
	Results   []Result `json:"results"`
	Engine    string   `json:"engine,omitempty"`
	Error     string   `json:"error,omitempty"`
	FromCache bool     `json:"from_cache,omitempty"`
}

// ── 全局 ──
var (
	httpClient *http.Client
	ua         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	acceptLg   = "zh-CN,zh;q=0.9,en;q=0.8"
	limiter    *RateLimiter
	cacheTTL   int64
)

// ── PID 管理 ──

func writePID(port int) {
	pid := os.Getpid()
	os.WriteFile(pidFile, []byte(fmt.Sprintf("%d\n%d", pid, port)), 0644)
}

func readPID() (pid int, port int, ok bool) {
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return 0, 0, false
	}
	parts := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(parts) < 2 {
		return 0, 0, false
	}
	pid, _ = strconv.Atoi(parts[0])
	port, _ = strconv.Atoi(parts[1])
	if pid < 1 || port < 1 {
		return 0, 0, false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return 0, 0, false
	}
	if runtime.GOOS == "windows" {
		return pid, port, true
	}
	err = proc.Signal(syscall.Signal(0))
	return pid, port, err == nil
}

func stopProcess(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return proc.Kill() == nil
	}
	err = proc.Signal(syscall.SIGTERM)
	if err != nil {
		return false
	}
	for i := 0; i < 50; i++ {
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			os.Remove(pidFile)
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	proc.Signal(syscall.SIGKILL)
	os.Remove(pidFile)
	return true
}

func checkPort(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return true
	}
	ln.Close()
	return false
}

func doStart() {
	if pid, _, ok := readPID(); ok {
		fmt.Printf("已在运行 (PID: %d)\n", pid)
		os.Exit(1)
	}
	if checkPort(*cliPort) {
		fmt.Printf("端口 %d 已被占用\n", *cliPort)
		os.Exit(1)
	}
	args := []string{}
	for _, a := range os.Args[1:] {
		if a != "-start" && a != "--start" {
			args = append(args, a)
		}
	}
	cmd := exec.Command(os.Args[0], args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Start()
	fmt.Printf("已后台启动 (PID: %d)\n", cmd.Process.Pid)
}

func doStop() {
	pid, _, ok := readPID()
	if !ok {
		fmt.Println("未找到运行中的实例")
		os.Exit(1)
	}
	if stopProcess(pid) {
		fmt.Printf("已停止 (PID: %d)\n", pid)
	} else {
		fmt.Printf("停止失败 (PID: %d)\n", pid)
		os.Exit(1)
	}
}

func doStatus() {
	if pid, port, ok := readPID(); ok && checkPort(port) {
		fmt.Printf("● 运行中  PID: %d  端口: %d\n", pid, port)
		fmt.Printf("  健康检查: http://localhost:%d/health\n", port)
		fmt.Printf("  统计数据: http://localhost:%d/stats\n", port)
		fmt.Printf("  PID 文件: %s\n", pidFile)
	} else {
		fmt.Println("○ 未运行")
		os.Remove(pidFile)
	}
}

func doRestart() {
	if pid, _, ok := readPID(); ok {
		stopProcess(pid)
		time.Sleep(500 * time.Millisecond)
	}
	doStart()
}

// ── recovery ──

func recoverWrap(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Printf("PANIC: %v", err)
				writeJSON(w, http.StatusInternalServerError, SearchResp{Error: "internal error"})
			}
		}()
		h(w, r)
	}
}

// ── 引擎实现 ──

var engineNames = []string{"google", "bing", "baidu", "ddg"}

func doGet(u string) (*http.Response, error) {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept-Language", acceptLg)
	return httpClient.Do(req)
}

func searchGoogle(q string, n int) []Result {
	u := fmt.Sprintf("https://www.google.com/search?q=%s&num=%d&hl=zh-CN", url.QueryEscape(q), n)
	resp, err := doGet(u)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
			codeLog("google", resp.StatusCode)
		} else {
			codeLog("google", 0)
		}
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	var out []Result
	for _, m := range reGoogleBlock.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		tm := reGoogleTitle.FindStringSubmatch(m[1])
		if tm == nil || strings.Contains(tm[1], "google.com") {
			continue
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		snip := ""
		if sm := reGoogleSnip.FindStringSubmatch(m[1]); sm != nil {
			snip = clean(sm[1])
		}
		out = append(out, Result{Title: title, URL: tm[1], Snippet: snip, Engine: "google"})
	}
	return out
}

func searchBing(q string, n int) []Result {
	u := fmt.Sprintf("https://www.bing.com/search?q=%s&count=%d", url.QueryEscape(q), n)
	resp, err := doGet(u)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
			codeLog("bing", resp.StatusCode)
		} else {
			codeLog("bing", 0)
		}
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	var out []Result
	for _, m := range reBingBlock.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		tm := reBingTitle.FindStringSubmatch(m[1])
		if tm == nil {
			continue
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		snip := ""
		if sm := reBingSnip.FindStringSubmatch(m[1]); sm != nil {
			snip = clean(sm[1])
		}
		out = append(out, Result{Title: title, URL: tm[1], Snippet: snip, Engine: "bing"})
	}
	return out
}

func searchDDG(q string, n int) []Result {
	u := fmt.Sprintf("https://lite.duckduckgo.com/lite/?q=%s", url.QueryEscape(q))
	resp, err := doGet(u)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
			codeLog("ddg", resp.StatusCode)
		} else {
			codeLog("ddg", 0)
		}
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	var out []Result
	for _, m := range reDDGLink.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		link := decodeEntities(m[1])
		title := clean(m[2])
		if title == "" || strings.Contains(link, "duckduckgo.com") {
			continue
		}
		out = append(out, Result{Title: title, URL: link, Snippet: "", Engine: "ddg"})
	}
	return out
}

func searchBaidu(q string, n int) []Result {
	u := fmt.Sprintf("https://www.baidu.com/s?wd=%s&rn=%d", url.QueryEscape(q), n)
	resp, err := doGet(u)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
			codeLog("baidu", resp.StatusCode)
		} else {
			codeLog("baidu", 0)
		}
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	var out []Result
	for _, m := range reBaiduBlock.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		tm := reBaiduTitle.FindStringSubmatch(m[1])
		if tm == nil {
			continue
		}
		link := tm[1]
		if !strings.HasPrefix(link, "http") {
			if dm := reBaiduDURL.FindStringSubmatch(m[1]); dm != nil {
				link = dm[1]
			}
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		snip := ""
		if sm := reBaiduSnip.FindStringSubmatch(m[1]); sm != nil {
			snip = clean(sm[1])
		}
		out = append(out, Result{Title: title, URL: link, Snippet: snip, Engine: "baidu"})
	}
	return out
}

func codeLog(engine string, code int) {
	if code == 0 {
		log.Printf("%s: network error", engine)
		return
	}
	switch code {
	case 429:
		log.Printf("%s: 429 rate limited", engine)
	case 503:
		log.Printf("%s: 503 unavailable", engine)
	case 403:
		log.Printf("%s: 403 blocked (可能需要验证码)", engine)
	default:
		log.Printf("%s: HTTP %d", engine, code)
	}
}

// ── 引擎索引 ──
var engineIdx = map[string]int{"google": 0, "bing": 1, "baidu": 2, "ddg": 3}

// ── 工具 ──

func clean(s string) string {
	s = reHTMLTags.ReplaceAllString(s, "")
	s = decodeEntities(s)
	return strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
}

func decodeEntities(s string) string {
	r := strings.NewReplacer(
		"&nbsp;", " ", "&lt;", "<", "&gt;", ">", "&amp;", "&",
		"&quot;", `"`, "&#39;", "'", "&apos;", "'",
		"&hellip;", "…", "&mdash;", "—", "&ndash;", "–",
	)
	return r.Replace(s)
}

func recordEngine(eng string, ok bool) {
	if idx, exists := engineIdx[eng]; exists {
		if ok {
			stats.EngineOK[idx].Add(1)
		} else {
			stats.EngineFail[idx].Add(1)
		}
	}
}

func parallelSearch(q string, n int) []Result {
	ch := make(chan []Result, 4)
	engines := []func(string, int) []Result{searchGoogle, searchBing, searchBaidu, searchDDG}
	for i, fn := range engines {
		go func(idx int, f func(string, int) []Result) {
			r := f(q, n)
			if r == nil {
				r = []Result{}
			}
			recordEngine(engineNames[idx], len(r) > 0)
			ch <- r
		}(i, fn)
	}
	seen := map[string]bool{}
	var out []Result
	for range engines {
		for _, r := range <-ch {
			key := strings.TrimRight(r.URL, "/")
			if !seen[key] {
				seen[key] = true
				out = append(out, r)
			}
		}
	}
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// ── Handler ──

func handleSearch(w http.ResponseWriter, r *http.Request) {
	stats.ReqTotal.Add(1)
	if !limiter.Allow() {
		stats.ReqRate.Add(1)
		writeJSON(w, http.StatusTooManyRequests, SearchResp{Error: "rate limited"})
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusBadRequest, SearchResp{Error: "missing q"})
		return
	}

	engine := r.URL.Query().Get("engine")
	if engine == "" {
		engine = "all"
	}

	n := 10
	fmt.Sscanf(r.URL.Query().Get("n"), "%d", &n)
	if n < 1 {
		n = 10
	}
	if n > 20 {
		n = 20
	}

	ck := fmt.Sprintf("%s|%s|%d", q, engine, n)
	if v, ok := cache.Load(ck); ok {
		ce := v.(cacheEntry)
		if time.Now().Unix() < ce.ExpiresAt {
			stats.CacheHit.Add(1)
			writeJSON(w, http.StatusOK, SearchResp{
				Success: true, Query: q, Engine: engine,
				Total: len(ce.Results), Results: ce.Results, FromCache: true,
			})
			return
		}
		cache.Delete(ck)
	}

	var results []Result
	switch engine {
	case "google":
		results = searchGoogle(q, n)
		recordEngine("google", len(results) > 0)
	case "bing":
		results = searchBing(q, n)
		recordEngine("bing", len(results) > 0)
	case "ddg":
		results = searchDDG(q, n)
		recordEngine("ddg", len(results) > 0)
	case "baidu":
		results = searchBaidu(q, n)
		recordEngine("baidu", len(results) > 0)
	case "all":
		results = parallelSearch(q, n)
	default:
		writeJSON(w, http.StatusBadRequest, SearchResp{Error: "unknown engine: " + engine})
		return
	}

	cache.Store(ck, cacheEntry{Results: results, ExpiresAt: time.Now().Add(time.Duration(cacheTTL) * time.Minute).Unix()})
	writeJSON(w, http.StatusOK, SearchResp{
		Success: true, Query: q, Engine: engine,
		Total: len(results), Results: results,
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "ok",
		"version": version,
		"engines": []string{"google", "bing", "ddg", "baidu", "all"},
		"uptime":  time.Now().UTC().Format(time.RFC3339),
	})
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(stats.StartTime).Round(time.Second).String()
	total := stats.ReqTotal.Load()
	cacheHit := stats.CacheHit.Load()
	rate := stats.ReqRate.Load()

	cacheRate := 0.0
	if total > 0 {
		cacheRate = float64(cacheHit) / float64(total) * 100
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uptime":     uptime,
		"req_total":  total,
		"req_rated":  rate,
		"cache_hit":  cacheHit,
		"cache_rate": fmt.Sprintf("%.1f%%", cacheRate),
		"engines": map[string]interface{}{
			"google": map[string]int64{"ok": stats.EngineOK[0].Load(), "fail": stats.EngineFail[0].Load()},
			"bing":   map[string]int64{"ok": stats.EngineOK[1].Load(), "fail": stats.EngineFail[1].Load()},
			"baidu":  map[string]int64{"ok": stats.EngineOK[2].Load(), "fail": stats.EngineFail[2].Load()},
			"ddg":    map[string]int64{"ok": stats.EngineOK[3].Load(), "fail": stats.EngineFail[3].Load()},
		},
		"version": version,
	})
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func main() {
	flag.Parse()

	if *cliVersion {
		fmt.Printf("metona-search-proxy v%s  go/%s\n", version, runtime.Version())
		return
	}
	if *cliStop {
		doStop()
		return
	}
	if *cliStatus {
		doStatus()
		return
	}
	if *cliStart {
		doStart()
		return
	}
	if *cliRestart {
		doRestart()
		return
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = fmt.Sprintf("%d", *cliPort)
	}
	portNum, _ := strconv.Atoi(port)

	if checkPort(portNum) {
		log.Fatalf("端口 %s 已被占用。使用 metona-search-proxy -status 查看。", port)
	}

	httpClient = &http.Client{
		Timeout: time.Duration(*cliTimeout) * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 20,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	limiter = newRateLimiter(int64(*cliRate), int64(*cliBurst))
	cacheTTL = int64(*cliCache)

	// 后台清理过期缓存
	go cleanCacheLoop(30 * time.Second)

	writePID(portNum)
	defer os.Remove(pidFile)

	mux := http.NewServeMux()
	mux.HandleFunc("/search", recoverWrap(handleSearch))
	mux.HandleFunc("/health", recoverWrap(handleHealth))
	mux.HandleFunc("/stats", recoverWrap(handleStats))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	log.Printf("metona-search-proxy v%s  :%s  engines: google/bing/ddg/baidu/all  cache: %dm  rate: %d/s",
		version, port, *cliCache, *cliRate)
	if err := srv.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	log.Println("stopped")
}
