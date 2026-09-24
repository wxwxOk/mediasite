#!/usr/bin/env python3
"""批量种子导入 - 多源聚合 HTTP only"""
import json, urllib.request, urllib.parse, time, datetime, sys, os, re, subprocess, threading

LOG_FILE = os.path.dirname(os.path.abspath(__file__)) + "/import-log.json"
BITMAGNET_IMPORT = os.environ.get("BITMAGNET_IMPORT", "http://localhost:3333/import")
CONTAINER = os.environ.get("BITMAGNET_CONTAINER", "bitmagnet-core")

# 热门搜索词（覆盖多种内容类型）
QUERIES = [
    "1080p x264", "2160p REMUX", "movies 2026", "tv series 2026",
    "music flac discography", "anime 1080p", "games pc download",
    "software windows", "ebooks pdf", "documentary bbc",
    "linux iso", "tutorial course", "audiobook mp3",
    "comics cbr", "xxx"
]

def fetch_url(url, timeout=15):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except: return None

def search_tpb(query, limit=30):
    """TPB API"""
    items = []
    try:
        url = f"https://apibay.org/q.php?q={urllib.parse.quote(query)}&cat=0"
        data = json.loads(fetch_url(url, 15) or b"[]")
        for item in data[:limit]:
            ih = item.get("info_hash","").lower().strip()
            name = item.get("name","")
            if len(ih) == 40 and name:
                items.append({"info_hash": ih, "name": name, "seeders": int(item.get("seeders",0))})
    except: pass
    return items

def search_nyaa(query, limit=20):
    """Nyaa.si"""
    items = []
    try:
        url = f"https://nyaa.si/?f=0&c=0_0&q={urllib.parse.quote(query)}&s=seeders&o=desc"
        html = fetch_url(url, 15)
        if not html: return items
        html = html.decode("utf-8", errors="ignore")
        rows = re.findall(r'<tr class="(?:default|success|danger)".*?</tr>', html, re.DOTALL)
        for row in rows[:limit]:
            title_m = re.search(r'<a href="/view/\d+".*?>(.*?)</a>', row)
            magnet_m = re.search(r'href="magnet:\?xt=urn:btih:([a-fA-F0-9]{40})', row)
            if title_m and magnet_m:
                items.append({"info_hash": magnet_m.group(1).lower(), "name": title_m.group(1).strip(), "seeders": 0})
    except: pass
    return items

def import_hashes(info_hashes):
    """批量导入到 bitmagnet"""
    imported = 0
    for ih in info_hashes:
        try:
            data = json.dumps({"infoHashes": [ih]}).encode()
            req = urllib.request.Request(BITMAGNET_IMPORT, data=data,
                headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5)
            imported += 1
            time.sleep(0.05)
        except: pass
    return imported

def trigger_reprocess():
    """触发分类处理；需要能免密执行 docker（把用户加入 docker 组）"""
    try:
        subprocess.run(
            ["docker", "exec", CONTAINER, "bitmagnet", "reprocess", "--orphans", "--batchSize", "500"],
            capture_output=True, text=True, timeout=30
        )
    except: pass

def run_full_import():
    """完整导入流程"""
    log = {"time": datetime.datetime.now().isoformat(), "results": [], "total_fetched": 0, "total_imported": 0}
    all_hashes = set()
    
    for q in QUERIES:
        tpb = search_tpb(q, 25)
        nya = search_nyaa(q, 15)
        all_items = tpb + nya
        
        # 去重
        new_hashes = []
        for item in all_items:
            h = item["info_hash"]
            if h not in all_hashes:
                all_hashes.add(h)
                new_hashes.append(h)
        
        imported = import_hashes(new_hashes)
        log["results"].append({
            "query": q, "fetched": len(tpb)+len(nya), "new": len(new_hashes), "imported": imported
        })
        log["total_fetched"] += len(tpb) + len(nya)
        log["total_imported"] += imported
        print(f"  {q}: fetched={len(tpb)+len(nya)} new={len(new_hashes)} imported={imported}")
        time.sleep(1)
    
    # 触发分类
    trigger_reprocess()
    log["reprocess_triggered"] = True
    
    # 保存日志
    with open(LOG_FILE, "w") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)
    
    return log

if __name__ == "__main__":
    print(f"开始导入 {datetime.datetime.now().isoformat()}")
    log = run_full_import()
    print(f"\n完成！总计: fetched={log['total_fetched']} imported={log['total_imported']}")
