package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var cache = sync.Map{}

type cacheEntry struct {
	Results   []SearchResult `json:"-"`
	ExpiresAt int64          `json:"-"`
}

type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Engine  string `json:"engine"`
}

type SearchResponse struct {
	Success bool           `json:"success"`
	Query   string         `json:"query"`
	Total   int            `json:"total"`
	Results []SearchResult `json:"results"`
	Error   string         `json:"error,omitempty"`
}

var httpClient = &http.Client{Timeout: 15 * time.Second}
var ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// ── Google ──
func searchGoogle(q string, n int) []SearchResult {
	u := fmt.Sprintf("https://www.google.com/search?q=%s&num=%d&hl=zh-CN", url.QueryEscape(q), n)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("Google: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		log.Printf("Google HTTP %d", resp.StatusCode)
		return nil
	}

	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reBlock := regexp.MustCompile(`<div class="g"[^>]*>([\s\S]*?)(?=<div class="g"|</div>\s*</div>\s*</div>)`)
	reTitle := regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)</h3>`)
	reSn := regexp.MustCompile(`<(?:div|span)[^>]*(?:data-sncf|class="[^"]*st[^"]*"|class="[^"]*VwiC3b[^"]*")[^>]*>([\s\S]*?)</(?:div|span)>`)

	var results []SearchResult
	for _, m := range reBlock.FindAllStringSubmatch(html, -1) {
		if len(results) >= n {
			break
		}
		tm := reTitle.FindStringSubmatch(m[1])
		if tm == nil {
			continue
		}
		title := clean(tm[2])
		link := tm[1]
		if title == "" || strings.Contains(link, "google.com") {
			continue
		}
		sn := ""
		if sm := reSn.FindStringSubmatch(m[1]); sm != nil {
			sn = clean(sm[1])
		}
		results = append(results, SearchResult{Title: title, URL: link, Snippet: sn, Engine: "google"})
	}
	return results
}

// ── Bing ──
func searchBing(q string, n int) []SearchResult {
	u := fmt.Sprintf("https://www.bing.com/search?q=%s&count=%d", url.QueryEscape(q), n)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reBlock := regexp.MustCompile(`<li class="b_algo"[^>]*>([\s\S]*?)</li>`)
	reTitle := regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>([\s\S]*?)</a>`)
	reSn := regexp.MustCompile(`<p[^>]*>([\s\S]*?)</p>`)

	var results []SearchResult
	for _, m := range reBlock.FindAllStringSubmatch(html, -1) {
		if len(results) >= n {
			break
		}
		tm := reTitle.FindStringSubmatch(m[1])
		if tm == nil {
			continue
		}
		title := clean(tm[2])
		if title == "" {
			continue
		}
		sn := ""
		if sm := reSn.FindStringSubmatch(m[1]); sm != nil {
			sn = clean(sm[1])
		}
		results = append(results, SearchResult{Title: title, URL: tm[1], Snippet: sn, Engine: "bing"})
	}
	return results
}

// ── DuckDuckGo Lite ──
func searchDDG(q string, n int) []SearchResult {
	u := fmt.Sprintf("https://lite.duckduckgo.com/lite/?q=%s", url.QueryEscape(q))
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ua)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	reLink := regexp.MustCompile(`<a[^>]*href="(https?://[^"]*)"[^>]*>([\s\S]*?)</a>`)

	var results []SearchResult
	for _, m := range reLink.FindAllStringSubmatch(html, -1) {
		if len(results) >= n {
			break
		}
		link := decodeEntities(m[1])
		title := clean(m[2])
		if title == "" || strings.Contains(link, "duckduckgo.com") {
			continue
		}
		results = append(results, SearchResult{Title: title, URL: link, Snippet: "", Engine: "ddg"})
	}
	return results
}

func clean(s string) string {
	s = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(s, "")
	s = decodeEntities(s)
	return strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
}

func decodeEntities(s string) string {
	repl := strings.NewReplacer(
		"&nbsp;", " ", "&lt;", "<", "&gt;", ">", "&amp;", "&",
		"&quot;", `"`, "&#39;", "'", "&apos;", "'",
		"&hellip;", "…", "&mdash;", "—", "&ndash;", "–",
	)
	return repl.Replace(s)
}

// ── Handler ──
func handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusBadRequest, SearchResponse{Success: false, Error: "missing q"})
		return
	}

	engine := r.URL.Query().Get("engine")
	if engine == "" {
		engine = "google"
	}

	n := 10
	fmt.Sscanf(r.URL.Query().Get("n"), "%d", &n)
	if n > 20 {
		n = 20
	}

	ck := fmt.Sprintf("%s|%s|%d", q, engine, n)
	if v, ok := cache.Load(ck); ok {
		ce := v.(cacheEntry)
		if time.Now().Unix() < ce.ExpiresAt {
			writeJSON(w, http.StatusOK, SearchResponse{Success: true, Query: q, Total: len(ce.Results), Results: ce.Results})
			return
		}
		cache.Delete(ck)
	}

	var results []SearchResult
	switch engine {
	case "google":
		results = searchGoogle(q, n)
	case "bing":
		results = searchBing(q, n)
	case "ddg":
		results = searchDDG(q, n)
	case "all":
		results = parallelSearch(q, n)
	default:
		writeJSON(w, http.StatusBadRequest, SearchResponse{Success: false, Error: "unknown engine: " + engine})
		return
	}

	cache.Store(ck, cacheEntry{Results: results, ExpiresAt: time.Now().Add(5 * time.Minute).Unix()})
	writeJSON(w, http.StatusOK, SearchResponse{Success: true, Query: q, Total: len(results), Results: results})
}

func parallelSearch(q string, n int) []SearchResult {
	ch := make(chan []SearchResult, 3)
	go func() { ch <- searchGoogle(q, n) }()
	go func() { ch <- searchBing(q, n) }()
	go func() { ch <- searchDDG(q, n) }()
	seen := map[string]bool{}
	var results []SearchResult
	for i := 0; i < 3; i++ {
		for _, r := range <-ch {
			key := strings.TrimRight(r.URL, "/")
			if !seen[key] {
				seen[key] = true
				results = append(results, r)
			}
		}
	}
	if len(results) > n {
		results = results[:n]
	}
	return results
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/search", handleSearch)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	log.Printf("search-proxy :%s  (google/bing/ddg/all)", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
