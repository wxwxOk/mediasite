const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// 海报统一走本地 /img 代理
export const img = (path, size = 'w342') => (path ? `/img/${size}${path}` : null);

const CSS = `
*{box-sizing:border-box}
:root{--bg:#111318;--card:#1b1e26;--fg:#e8eaf0;--dim:#9aa3b2;--acc:#4c9aff;--line:#2a2f3a}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit;text-decoration:none}
header{position:sticky;top:0;z-index:9;display:flex;gap:16px;align-items:center;padding:12px 20px;background:rgba(17,19,24,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{font-size:18px;font-weight:700;white-space:nowrap}
.brand span{color:var(--acc)}
form.search{display:flex;gap:8px;flex:1;max-width:460px}
input,select,button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
input[type=search]{flex:1;min-width:0}
input[type=checkbox]{padding:0;width:15px;height:15px;accent-color:var(--acc)}
button{cursor:pointer}
button:hover{border-color:var(--acc)}
nav.tabs{margin-left:auto;display:flex;gap:6px}
nav.tabs a{padding:6px 12px;border-radius:8px;color:var(--dim)}
nav.tabs a.on{background:var(--card);color:var(--fg)}
main{padding:20px;max-width:1500px;margin:0 auto}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:18px}
.filters .count{margin-left:auto;color:var(--dim)}
.filters.fgrid{flex-direction:column;align-items:stretch;gap:10px}
.filters.fgrid .count{align-self:flex-end}
.filters .count a{color:var(--acc)}
.fgroup{display:flex;gap:8px;align-items:flex-start}
.flabel{flex:none;width:34px;padding:3px 0;color:var(--dim);font-size:13px}
.chips{display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0}
.chip{position:relative;border:1px solid var(--line);border-radius:20px;padding:3px 12px;font-size:13px;color:var(--dim);cursor:pointer;user-select:none;white-space:nowrap}
.chip:hover{border-color:var(--acc);color:var(--fg)}
.chip.on{background:var(--acc);border-color:var(--acc);color:#06101d}
.chip input{position:absolute;opacity:0;pointer-events:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}
.card{background:var(--card);border-radius:10px;overflow:hidden;transition:transform .12s}
.card:hover{transform:translateY(-3px)}
.card .main{display:block}
.poster{position:relative;aspect-ratio:2/3;background:#0c0e12}
.poster img{width:100%;height:100%;object-fit:cover;display:block}
.poster .none{display:flex;height:100%;align-items:center;justify-content:center;color:#3b4250;font-size:12px}
.badge{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.7);border-radius:6px;padding:2px 6px;font-size:12px;font-weight:600;color:#ffd166}
.type{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.7);border-radius:6px;padding:2px 6px;font-size:11px;color:var(--dim)}
.mag{position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,.7);border-radius:6px;padding:2px 6px;font-size:11px;color:#57b26b}
.d250{position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.7);border-radius:6px;padding:2px 6px;font-size:11px;font-weight:600;color:#57b26b}
.rank{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.78);border-radius:6px;padding:2px 7px;font-size:13px;font-weight:700;color:#ffd166}
.card.miss{opacity:.5;cursor:default}
.card.miss:hover{transform:none}
.tip{color:var(--dim);font-size:13px}
.meta{padding:8px 10px}
.meta .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .s{color:var(--dim);font-size:12px;margin-top:2px}
.ratings{display:flex;gap:5px;flex-wrap:wrap;padding:0 10px 9px}
.ratings a{font-size:11px;border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--dim)}
.ratings a:hover{border-color:var(--acc);color:var(--fg)}
.facts a.douban{color:#57b26b}
.ratings .rt{color:#ff6b6b}
.ratings .pp{color:#ffd166}
.pager{display:flex;gap:6px;justify-content:center;margin:26px 0 10px;flex-wrap:wrap}
.pager a,.pager b{padding:6px 11px;border:1px solid var(--line);border-radius:8px;font-weight:400}
.pager b{background:var(--acc);border-color:var(--acc);color:#06101d}
.pager .gap{color:var(--dim);padding:6px 4px}
.detail{display:flex;gap:26px;flex-wrap:wrap}
.detail .poster{width:280px;flex:none;aspect-ratio:2/3;border-radius:10px;overflow:hidden;background:var(--card)}
.detail .poster img{width:100%;height:100%;object-fit:cover}
.detail .info{flex:1;min-width:300px}
.detail h1{margin:0 0 4px;font-size:26px}
.detail .alt{color:var(--dim);margin-bottom:12px}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.facts span{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 10px;font-size:13px}
.facts span b{color:var(--acc);font-weight:600}
.facts a{color:inherit}
.facts a:hover{text-decoration:underline}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}
.tags a{border:1px solid var(--line);border-radius:20px;padding:3px 12px;font-size:13px;color:var(--dim)}
.tags a:hover{border-color:var(--acc);color:var(--fg)}
h2{font-size:16px;margin:22px 0 8px;color:var(--dim);font-weight:600}
p.ov{line-height:1.75;white-space:pre-wrap}
.cast{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}
.cast div{text-align:center;font-size:12px;color:var(--dim)}
.cast img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:8px;background:var(--card)}
.empty{color:var(--dim);padding:60px 0;text-align:center}
.fav{display:flex;gap:8px;align-items:center;margin-top:18px;flex-wrap:wrap}
.fav b{color:var(--dim);font-weight:600}
.login{max-width:300px;margin:90px auto}
.login form{display:flex;flex-direction:column;gap:12px}
.login h1{margin:0 0 6px;font-size:22px;text-align:center}
.login .err{color:#ff6b6b;margin:0;text-align:center}
.find{background:var(--acc);border-color:var(--acc);color:#06101d;font-weight:600;padding:9px 20px}
.mgtabs{display:flex;gap:6px;margin:0 0 10px;flex-wrap:wrap}
.mgtabs.g{margin-bottom:6px}
.mgtabs.g button{font-weight:600}
.mgtabs .gl{color:var(--dim);font-size:12px;align-self:center}
.mgtabs button{background:none;color:var(--dim)}
.mgtabs button.on{background:var(--card);border-color:var(--acc);color:var(--fg)}
.mgtabs b{color:var(--acc);font-weight:600}
table.mg{width:100%;border-collapse:collapse;font-size:13px}
table.mg th{text-align:left;color:var(--dim);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
table.mg td{padding:6px 8px;border-bottom:1px solid var(--line)}
table.mg td.n{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table.mg tr.hit td.n{color:var(--acc)}
table.mg td.n b.zh{font-size:11px;font-weight:600;color:#57b26b;border:1px solid #35543d;border-radius:5px;padding:0 5px;margin-right:6px}
table.mg button{padding:3px 10px;font-size:12px}
footer{border-top:1px solid var(--line);margin-top:40px;padding:18px 20px;color:var(--dim);font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
footer img{height:14px;vertical-align:middle}
`;

// 鉴权开启时才在页脚露出退出入口，避免无鉴权时显示无意义的链接
let AUTH = false;
export const setAuthEnabled = (v) => { AUTH = v; };

export function layout({ title = '', q = '', body = '', tabs = '' }) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title ? `${title} - 影视库` : '影视库')}</title>
<style>${CSS}</style>
</head><body>
<header>
  <a class="brand" href="/">影视<span>库</span></a>
  <form class="search" action="/" method="get">
    <input type="search" name="q" value="${esc(q)}" placeholder="搜索片名 / 原名…">
    <button type="submit">搜索</button>
  </form>
  ${tabs}
</header>
<main>${body}</main>
<footer>
  <img src="/tmdb-logo.svg" alt="TMDB" width="60" height="14">
  <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
  ${AUTH ? '<a href="/logout" style="margin-left:auto">退出</a>' : ''}
</footer>
</body></html>`;
}
