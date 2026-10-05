// 校园树木地图 —— 一键启动器
//
// 把网页和数据服务打包成单个可执行文件，双击即用，不需要装 Python。
//
//	macOS   → 双击「校园树木地图.app」
//	Windows → 双击「校园树木地图.exe」
//
// 数据存在用户自己的「文稿/CampusTreeMap」目录里，不在应用内部，
// 方便备份、交接，也避免应用被删除时数据跟着没了。
package main

import (
	"crypto/sha1"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:web
var embedded embed.FS

const (
	appTitle  = "校园树木地图"
	dataDirNm = "CampusTreeMap"
	firstPort = 8080
	dupRadius = 15.0 // 米，判断"是不是同一棵树"的容错半径
)

// 校园大致范围 (S, W, N, E)，用来挡掉明显错误的坐标
var campusBounds = [4]float64{39.055, 117.615, 39.080, 117.660}

type Tree map[string]any

// ------------------------------------------------------------------ 数据

type store struct {
	mu    sync.Mutex
	trees map[string]Tree
	dir   string
	subs  map[chan []byte]bool
}

func newStore(dir string) *store {
	return &store{trees: map[string]Tree{}, dir: dir, subs: map[chan []byte]bool{}}
}

func (s *store) treeFile() string  { return filepath.Join(s.dir, "trees.json") }
func (s *store) photosDir() string { return filepath.Join(s.dir, "photos") }

func (s *store) load() {
	raw, err := os.ReadFile(s.treeFile())
	if err != nil {
		return
	}
	var doc struct {
		Trees []Tree `json:"trees"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return
	}
	for _, t := range doc.Trees {
		if id, ok := t["id"].(string); ok && id != "" {
			s.trees[id] = t
		}
	}
}

// 先写临时文件再改名，避免写一半崩溃把数据弄坏
func (s *store) saveLocked() {
	os.MkdirAll(s.dir, 0o755)
	list := make([]Tree, 0, len(s.trees))
	for _, t := range s.trees {
		list = append(list, t)
	}
	raw, err := json.Marshal(map[string]any{"trees": list})
	if err != nil {
		return
	}
	tmp := s.treeFile() + ".tmp"
	if os.WriteFile(tmp, raw, 0o644) == nil {
		os.Rename(tmp, s.treeFile())
	}
}

// 把界面传来的 dataURL 照片落成文件；已经是路径的原样保留
func (s *store) storePhotos(rec Tree) Tree {
	out := []string{}
	arr, _ := rec["photos"].([]any)
	for i, p := range arr {
		if i >= 3 {
			break
		}
		str, ok := p.(string)
		if !ok || str == "" {
			continue
		}
		if !strings.HasPrefix(str, "data:image/") {
			out = append(out, str)
			continue
		}
		idx := strings.Index(str, ",")
		if idx < 0 {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(str[idx+1:])
		if err != nil {
			continue
		}
		sum := sha1.Sum(raw)
		name := hex.EncodeToString(sum[:])[:16] + ".jpg"
		os.MkdirAll(s.photosDir(), 0o755)
		fp := filepath.Join(s.photosDir(), name)
		if _, err := os.Stat(fp); err != nil {
			os.WriteFile(fp, raw, 0o644)
		}
		out = append(out, "photos/"+name)
	}
	rec["photos"] = out
	return rec
}

func (s *store) broadcast(ev any) {
	raw, _ := json.Marshal(ev)
	s.mu.Lock()
	subs := make([]chan []byte, 0, len(s.subs))
	for ch := range s.subs {
		subs = append(subs, ch)
	}
	s.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- raw:
		default: // 这个客户端卡住了就跳过，别拖累别人
		}
	}
}

// ------------------------------------------------------------------ 校验

func asFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(x, 64)
		return f, err == nil
	}
	return 0, false
}

func validCoords(rec Tree) bool {
	lat, ok1 := asFloat(rec["lat"])
	lon, ok2 := asFloat(rec["lon"])
	if !ok1 || !ok2 {
		return false
	}
	if math.IsNaN(lat) || math.IsNaN(lon) {
		return false
	}
	return lat >= campusBounds[0] && lat <= campusBounds[2] &&
		lon >= campusBounds[1] && lon <= campusBounds[3]
}

func distM(a, b Tree) float64 {
	alat, _ := asFloat(a["lat"])
	alon, _ := asFloat(a["lon"])
	blat, _ := asFloat(b["lat"])
	blon, _ := asFloat(b["lon"])
	const earth = 6371000.0
	dLat := (blat - alat) * math.Pi / 180
	dLon := (blon - alon) * math.Pi / 180
	mid := ((alat + blat) / 2) * math.Pi / 180
	return math.Hypot(dLat, dLon*math.Cos(mid)) * earth
}

func samePlace(a, b Tree) bool { return distM(a, b) <= dupRadius }

func shortID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	n := time.Now().UnixNano()
	b := make([]byte, 4)
	for i := range b {
		b[i] = chars[(n>>(uint(i)*7))%int64(len(chars))]
	}
	return string(b)
}

// ------------------------------------------------------------------ 接口

func (s *store) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	list := make([]Tree, 0, len(s.trees))
	for _, t := range s.trees {
		list = append(list, t)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		a, _ := asFloat(list[i]["created"])
		b, _ := asFloat(list[j]["created"])
		return a < b
	})
	writeJSON(w, map[string]any{"trees": list, "server": true})
}

// 用了 SSE（服务器推事件）让别人的记录自动出现，断了浏览器会自己重连
func (s *store) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)
	flusher.Flush()

	ch := make(chan []byte, 32)
	s.mu.Lock()
	s.subs[ch] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}()

	io.WriteString(w, ": connected\n\n")
	flusher.Flush()

	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case raw := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", raw)
			flusher.Flush()
		case <-tick.C:
			io.WriteString(w, ": ping\n\n") // 心跳，防中间设备把连接掐掉
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *store) handlePutTree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Tree Tree `json:"tree"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.Tree == nil {
		writeJSON(w, map[string]any{"error": "请求体不是合法 JSON"}, 400)
		return
	}
	rec := body.Tree
	id, _ := rec["id"].(string)
	if id == "" {
		writeJSON(w, map[string]any{"error": "记录缺少 id"}, 400)
		return
	}
	if !validCoords(rec) {
		writeJSON(w, map[string]any{"error": "记录坐标不合法"}, 400)
		return
	}
	rec = s.storePhotos(rec)

	renamed := false
	s.mu.Lock()
	if old, exists := s.trees[id]; exists && !samePlace(old, rec) {
		// 同一个 id 但位置差很远：不同的人各自生成的 id 撞号了。
		// 直接覆盖会把别人的记录悄悄抹掉，这里换个新 id 存下来。
		id = id + "_" + shortID()
		rec["id"] = id
		renamed = true
	}
	s.trees[id] = rec
	s.saveLocked()
	s.mu.Unlock()

	s.broadcast(map[string]any{"type": "upsert", "tree": rec})
	writeJSON(w, map[string]any{"ok": true, "tree": rec, "renamed": renamed})
}

func (s *store) handleBulk(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Trees []Tree `json:"trees"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		writeJSON(w, map[string]any{"error": "请求体不是合法 JSON"}, 400)
		return
	}
	saved := []Tree{}
	s.mu.Lock()
	for _, rec := range body.Trees {
		id, _ := rec["id"].(string)
		if id == "" || !validCoords(rec) {
			continue
		}
		rec = s.storePhotos(rec)
		if old, exists := s.trees[id]; exists && !samePlace(old, rec) {
			id = id + "_" + shortID()
			rec["id"] = id
		}
		s.trees[id] = rec
		saved = append(saved, rec)
	}
	s.saveLocked()
	s.mu.Unlock()

	if len(saved) > 0 {
		s.broadcast(map[string]any{"type": "bulk", "trees": saved})
	}
	writeJSON(w, map[string]any{"ok": true, "count": len(saved)})
}

func (s *store) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/trees/")
	if u, err := urlUnescape(id); err == nil {
		id = u
	}
	s.mu.Lock()
	_, existed := s.trees[id]
	delete(s.trees, id)
	if existed {
		s.saveLocked()
	}
	s.mu.Unlock()
	if existed {
		s.broadcast(map[string]any{"type": "delete", "id": id})
	}
	writeJSON(w, map[string]any{"ok": existed})
}

// ------------------------------------------------------------------ 工具

func writeJSON(w http.ResponseWriter, obj any, code ...int) {
	status := 200
	if len(code) > 0 {
		status = code[0]
	}
	raw, _ := json.Marshal(obj)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(raw)
}

// 只处理百分号转义，够本项目用（记录 id 里不会出现怪异字符）
func urlUnescape(s string) (string, error) {
	if !strings.Contains(s, "%") {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			v, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
			if err != nil {
				return "", err
			}
			b.WriteByte(byte(v))
			i += 2
		} else {
			b.WriteByte(s[i])
		}
	}
	return b.String(), nil
}

func lanIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return addr.IP.String()
	}
	return "127.0.0.1"
}

// 8080 常被别的程序占着（比如 Java 服务），被占就自动往后找
func pickPort(start int) int {
	for p := start; p < start+30; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", p))
		if err == nil {
			ln.Close()
			return p
		}
	}
	return start
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func dataDirPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, "Documents", dataDirNm)
}

// ------------------------------------------------------------------ 启动

func main() {
	dir := dataDirPath()
	os.MkdirAll(filepath.Join(dir, "photos"), 0o755)

	st := newStore(dir)
	st.load()

	port := pickPort(firstPort)

	webRoot, err := fs.Sub(embedded, "web")
	if err != nil {
		log.Fatal(err)
	}
	files := http.FileServer(http.FS(webRoot))

	mux := http.NewServeMux()

	mux.HandleFunc("/api/snapshot", st.handleSnapshot)
	mux.HandleFunc("/api/events", st.handleEvents)
	mux.HandleFunc("/api/trees", st.handlePutTree)
	mux.HandleFunc("/api/trees/", st.handleDelete)
	mux.HandleFunc("/api/bulk", st.handleBulk)

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		n, online := len(st.trees), len(st.subs)
		st.mu.Unlock()
		writeJSON(w, map[string]any{"trees": n, "online": online})
	})

	// 网页上用这个接口把"发给学生的地址"显示出来
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"lan":     fmt.Sprintf("http://%s:%d/", lanIP(), port),
			"local":   fmt.Sprintf("http://127.0.0.1:%d/", port),
			"port":    port,
			"dataDir": dir,
		})
	})

	// 照片从用户数据目录里读，不在打包资源里
	mux.HandleFunc("/photos/", func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.URL.Path)
		fp := filepath.Join(st.photosDir(), name)
		if _, err := os.Stat(fp); err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=604800")
		http.ServeFile(w, r, fp)
	})

	// 其余都当静态文件服务（网页、瓦片、渲染库都打包在里面了）
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/tiles/") || strings.Contains(r.URL.Path, "/vendor/") {
			w.Header().Set("Cache-Control", "public, max-age=604800")
		}
		files.ServeHTTP(w, r)
	})

	url := fmt.Sprintf("http://127.0.0.1:%d/", port)

	// 双击启动时没有终端窗口，这些内容主要给命令行启动时看；
	// 关键信息（发给学生的地址）会在网页上显示出来。
	fmt.Printf("\n  %s 已启动\n", appTitle)
	fmt.Printf("  本机打开   : %s\n", url)
	fmt.Printf("  发给学生的 : http://%s:%d/\n", lanIP(), port)
	fmt.Printf("  数据保存在 : %s\n", dir)
	fmt.Printf("\n  关掉这个窗口就是关闭服务。\n\n")

	go func() {
		time.Sleep(500 * time.Millisecond) // 等服务真正起来再开浏览器
		openBrowser(url)
	}()

	srv := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux}
	if err := srv.ListenAndServe(); err != nil {
		fmt.Printf("\n  启动失败：%v\n", err)
		fmt.Print("  3 秒后自动关闭…")
		time.Sleep(3 * time.Second)
	}
}
