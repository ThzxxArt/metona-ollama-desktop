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

const version = "2.1.0"

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
		current := rl.tokens.Load()
		next := current + newTokens
		if next > rl.capacity {
			next = rl.capacity
		}
		rl.tokens.Store(next)
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

// ── 全局配置 ──
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
	// 检查进程是否存在
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
	// 等待进程退出
	for i := 0; i < 50; i++ {
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			os.Remove(pidFile)
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	// force kill
	proc.Signal(syscall.SIGKILL)
	os.Remove(pidFile)
	return true
}

func checkPort(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return true // 端口已被占用 = 服务在运行
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
	// 后台启动自己
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

// ── recovery 中间件 ──
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

func doGet(u string) (*http.Response, error) {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept-Language", acceptLg)
	return httpClient.Do(req)
}

func searchGoogle(q string, n int) []Result {
	u := fmt.Sprintf("https://www.google.com/search?q=%s&num=%d&hl=zh-CN", url.QueryEscape(q), n)
	resp, err := doGet(u)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reB := regexp.MustCompile(`<div class="g"[^>]*>([\s\S]*?)(?=<div class="g"|</div>\s*</div>\s*</div>)`)
	reT := regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)</h3>`)
	reS := regexp.MustCompile(`<(?:div|span)[^>]*(?:data-sncf|class="[^"]*st[^"]*"|class="[^"]*VwiC3b[^"]*")[^>]*>([\s\S]*?)</(?:div|span)>`)

	var out []Result
	for _, m := range reB.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		tm := reT.FindStringSubmatch(m[1])
		if tm == nil || strings.Contains(tm[1], "google.com") {
			continue
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		snip := ""
		if sm := reS.FindStringSubmatch(m[1]); sm != nil {
			snip = clean(sm[1])
		}
		out = append(out, Result{Title: title, URL: tm[1], Snippet: snip, Engine: "google"})
	}
	return out
}

func searchBing(q string, n int) []Result {
	u := fmt.Sprintf("https://www.bing.com/search?q=%s&count=%d", url.QueryEscape(q), n)
	resp, err := doGet(u)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reB := regexp.MustCompile(`<li class="b_algo"[^>]*>([\s\S]*?)</li>`)
	reT := regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>([\s\S]*?)</a>`)
	reS := regexp.MustCompile(`<p[^>]*>([\s\S]*?)</p>`)

	var out []Result
	for _, m := range reB.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		tm := reT.FindStringSubmatch(m[1])
		if tm == nil {
			continue
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		snip := ""
		if sm := reS.FindStringSubmatch(m[1]); sm != nil {
			snip = clean(sm[1])
		}
		out = append(out, Result{Title: title, URL: tm[1], Snippet: snip, Engine: "bing"})
	}
	return out
}

func searchDDG(q string, n int) []Result {
	u := fmt.Sprintf("https://lite.duckduckgo.com/lite/?q=%s", url.QueryEscape(q))
	resp, err := doGet(u)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reL := regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>([\s\S]*?)</a>`)

	var out []Result
	for _, m := range reL.FindAllStringSubmatch(html, -1) {
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
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reB := regexp.MustCompile(`<div class="result[^"]*"[^>]*>([\s\S]*?)(?=<div class="result|<div id="content_right|$)`)
	reT := regexp.MustCompile(`<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>`)
	reS := regexp.MustCompile(`<div class="c-abstract"[^>]*>([\s\S]*?)</div>`)

	var out []Result
	for _, m := range reB.FindAllStringSubmatch(html, -1) {
		if len(out) >= n {
			break
		}
		tm := reT.FindStringSubmatch(m[1])
		if tm == nil {
			continue
		}
		link := tm[1]
		if !strings.HasPrefix(link, "http") {
			if dm := regexp.MustCompile(`data-url="(https?://[^"]*)"`).FindStringSubmatch(m[1]); dm != nil {
				link = dm[1]
			}
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		snip := ""
		if sm := reS.FindStringSubmatch(m[1]); sm != nil {
			snip = clean(sm[1])
		}
		out = append(out, Result{Title: title, URL: link, Snippet: snip, Engine: "baidu"})
	}
	return out
}

// ── 工具 ──

func clean(s string) string {
	s = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(s, "")
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

func parallelSearch(q string, n int) []Result {
	ch := make(chan []Result, 4)
	engines := []func(string, int) []Result{searchGoogle, searchBing, searchBaidu, searchDDG}
	for _, fn := range engines {
		go func(f func(string, int) []Result) {
			r := f(q, n)
			if r == nil {
				r = []Result{}
			}
			ch <- r
		}(fn)
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
	if !limiter.Allow() {
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
	case "bing":
		results = searchBing(q, n)
	case "ddg":
		results = searchDDG(q, n)
	case "baidu":
		results = searchBaidu(q, n)
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

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// ── main ──

func main() {
	flag.Parse()

	// 管理命令（不需要启动服务）
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

	// 检查端口是否已被占用
	if checkPort(portNum) {
		log.Fatalf("端口 %s 已被占用。使用 metona-search-proxy -status 查看状态，或用 -restart 重启。", port)
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

	writePID(portNum)
	defer os.Remove(pidFile)

	mux := http.NewServeMux()
	mux.HandleFunc("/search", recoverWrap(handleSearch))
	mux.HandleFunc("/health", recoverWrap(handleHealth))

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
