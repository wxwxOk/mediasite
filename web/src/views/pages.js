import { layout, esc, img } from './layout.js';

const DECADES = [2020, 2010, 2000, 1990];
const VOTES = [9, 8, 7, 6];
const SORTS = { popularity: '按热度', vote: '按评分', newest: '最新上映', oldest: '最早上映', latest: '最近入库' };

function qs(base, patch = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) {
    if (v == null || v === '') continue;
    for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  }
  const s = p.toString();
  return s ? `/?${s}` : '/';
}

const options = (vals, cur, label) =>
  [`<option value="">${label}</option>`]
    .concat(vals.map((v) => `<option value="${v[0]}"${String(cur) === String(v[0]) ? ' selected' : ''}>${esc(v[1])}</option>`))
    .join('');

const LANG_LABEL = { en: '英语', fr: '法语', ja: '日语', es: '西语', ko: '韩语', it: '意语', de: '德语', zh: '华语', hi: '印地语', pt: '葡语', ru: '俄语', da: '丹麦语', no: '挪威语', sv: '瑞典语', pl: '波兰语', tr: '土耳其语', nl: '荷兰语', th: '泰语', fi: '芬兰语', id: '印尼语', ar: '阿拉伯语' };

// 平铺多选：checkbox 组传数组，radio 组（single）传当前值；未选中即「全部/不限」
const chips = (name, pairs, sel, single) =>
  pairs
    .map(([v, n]) => {
      const on = single ? String(sel) === String(v) : (sel ?? []).includes(String(v));
      return `<label class="chip${on ? ' on' : ''}"><input type="${single ? 'radio' : 'checkbox'}" name="${name}" value="${v}"${on ? ' checked data-on="1"' : ''}>${esc(n)}</label>`;
    })
    .join('');

const rtUrl = (t) => `https://www.rottentomatoes.com/${t.media_type === 'movie' ? 'm' : 'tv'}/${esc(t.rt_vanity)}`;

// 卡片底部的第三方评分行：烂番茄/爆米花跳 RT 页（豆瓣只在详情页显示，见 detailPage）
const ratingRow = (t) => {
  const items = [];
  if (t.rt_critics) items.push(`<a href="${rtUrl(t)}" target="_blank" rel="noopener" class="rt" title="烂番茄指数">🍅 ${t.rt_critics}%</a>`);
  if (t.rt_audience) items.push(`<a href="${rtUrl(t)}" target="_blank" rel="noopener" class="pp" title="爆米花指数">🍿 ${t.rt_audience}%</a>`);
  return items.length ? `<div class="ratings">${items.join('')}</div>` : '';
};

const card = (t) => `<div class="card">
  <a class="main" href="/t/${t.id}">
    <div class="poster">
      ${t.poster_path ? `<img src="${img(t.poster_path)}" alt="" loading="lazy">` : '<div class="none">无海报</div>'}
      ${t.vote_average ? `<span class="badge">${t.vote_average.toFixed(1)}</span>` : ''}
      <span class="type">${t.media_type === 'movie' ? '电影' : '剧集'}</span>
      ${t.magnet_count > 0 ? `<span class="mag" title="磁力资源">🧲${t.magnet_count > 99 ? '99+' : t.magnet_count}</span>` : ''}
    </div>
    <div class="meta">
      <div class="t">${esc(t.title)}</div>
      <div class="s">${t.release_year ?? '—'}</div>
    </div>
  </a>
  ${ratingRow(t)}
</div>`;

function pager(base, page, pages) {
  if (pages <= 1) return '';
  const nums = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  let mid = '';
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) mid += '<span class="gap">…</span>';
    mid += n === page ? `<b>${n}</b>` : `<a href="${qs(base, { page: n })}">${n}</a>`;
    prev = n;
  }
  return `<div class="pager">
    ${page > 1 ? `<a href="${qs(base, { page: page - 1 })}">上一页</a>` : ''}${mid}
    ${page < pages ? `<a href="${qs(base, { page: page + 1 })}">下一页</a>` : ''}
  </div>`;
}

// active 用于非浏览类页面（如爬虫台）标记自身，不传时行为与从前完全一致
// 切换类型时清掉类型（genre id 按电影/剧集分属两套，跨类型保留会错配）
const tabs = (type, f, active = '') => `<nav class="tabs">
  <a class="${!active && !type ? 'on' : ''}" href="${qs(f, { type: '', page: 1, genre: [] })}">全部</a>
  <a class="${!active && type === 'movie' ? 'on' : ''}" href="${qs(f, { type: 'movie', page: 1, genre: [] })}">电影</a>
  <a class="${!active && type === 'tv' ? 'on' : ''}" href="${qs(f, { type: 'tv', page: 1, genre: [] })}">剧集</a>
  <a href="/favorites">收藏</a>
  <a class="${active === 'crawler' ? 'on' : ''}" href="/crawler">爬虫</a>
</nav>`;

export function browsePage({ result, f, genres, langs }) {
  const groups = [
    ['lang', '语言', langs.map((l) => [l.code, LANG_LABEL[l.code] ?? l.code.toUpperCase()]), f.lang],
    ['genre', '类型', genres.map((g) => [g.id, g.name]), f.genre],
    ['decade', '年代', DECADES.map((d) => [d, `${d} 年代`]), f.decade],
    ['minVote', '评分', VOTES.map((v) => [v, `${v}+`]), f.minVote, true],
    ['sort', '排序', Object.entries(SORTS), f.sort || 'popularity', true],
  ];
  const active = f.genre.length || f.decade.length || f.lang.length || f.minVote || f.sort;

  const filterBar = `<form class="filters fgrid" method="get" action="/">
    ${f.q ? `<input type="hidden" name="q" value="${esc(f.q)}">` : ''}
    ${f.type ? `<input type="hidden" name="type" value="${esc(f.type)}">` : ''}
    ${groups.map(([name, label, pairs, sel, single]) => `<div class="fgroup"><span class="flabel">${label}</span><div class="chips">${chips(name, pairs, sel, single)}</div></div>`).join('')}
    <span class="count">共 ${result.total} 条${active ? ` · <a href="${qs({ q: f.q, type: f.type })}">重置</a>` : ''}</span>
  </form>
  <script>
  (() => {
    const form = document.querySelector('form.filters');
    form.addEventListener('click', (e) => {
      const r = e.target.closest('input[type=radio]');
      if (r?.dataset.on === '1') { r.checked = false; form.submit(); }
    });
    form.addEventListener('change', (e) => {
      e.target.dataset.on = e.target.checked ? '1' : '';
      form.submit();
    });
  })();
  </script>`;

  const body = `<h1 style="margin:0 0 14px;font-size:20px">${f.q ? `搜索「${esc(f.q)}」` : '浏览'}</h1>
    ${filterBar}
    ${result.items.length ? `<div class="grid">${result.items.map(card).join('')}</div>` : '<div class="empty">没有匹配的结果</div>'}
    ${pager(f, result.page, result.pages)}`;

  return layout({ title: f.q || '浏览', q: f.q, tabs: tabs(f.type, f), body });
}

export function detailPage(t, fav) {
  const e = t.extra ?? {};
  const isMovie = t.media_type === 'movie';
  const STATUS = { want: '想看', watching: '在看', done: '看过' };

  const facts = [
    t.release_year ? `<span>${t.release_year}${t.release_date ? `-${esc(t.release_date.slice(5))}` : ''}</span>` : '',
    isMovie
      ? e.runtime ? `<span>片长 <b>${e.runtime}</b> 分钟</span>` : ''
      : e.seasons ? `<span><b>${e.seasons}</b> 季 · <b>${e.episodes ?? '?'}</b> 集</span>` : '',
    t.vote_average ? `<span>评分 <b>${t.vote_average.toFixed(1)}</b> · ${t.vote_count} 人</span>` : '',
    // 豆瓣评分占位：页面加载后异步请求 /api/douban/:id 填充，避免列表/详情渲染直接打豆瓣
    '<span id="douban" hidden></span>',
    t.rt_critics ? `<span><a href="${rtUrl(t)}" target="_blank" rel="noopener">烂番茄 <b>${t.rt_critics}%</b></a></span>` : '',
    t.rt_audience ? `<span><a href="${rtUrl(t)}" target="_blank" rel="noopener">爆米花 <b>${t.rt_audience}%</b></a></span>` : '',
    e.status ? `<span>${esc(e.status)}</span>` : '',
    isMovie && e.budget ? `<span>预算 <b>$${(e.budget / 1e6).toFixed(0)}M</b></span>` : '',
    isMovie && e.revenue ? `<span>票房 <b>$${(e.revenue / 1e6).toFixed(0)}M</b></span>` : '',
    t.original_language ? `<span>${esc(t.original_language.toUpperCase())}</span>` : '',
  ].filter(Boolean).join('');

  const cast = (e.cast ?? []).length
    ? `<h2>主要演员</h2><div class="cast">${e.cast
        .map((c) => `<div>${c.img ? `<img src="${img(c.img, 'w185')}" alt="" loading="lazy">` : ''}<div>${esc(c.name)}</div></div>`)
        .join('')}</div>`
    : '';

  const body = `<div class="detail">
    <div class="poster">${t.poster_path ? `<img src="${img(t.poster_path, 'w500')}" alt="">` : '<div class="none">无海报</div>'}</div>
    <div class="info">
      <h1>${esc(t.title)}</h1>
      ${t.original_title && t.original_title !== t.title ? `<div class="alt">${esc(t.original_title)}</div>` : ''}
      <div class="facts">${facts}</div>
      <script>
      (() => {
        fetch('/api/douban/${t.id}')
          .then((r) => r.json())
          .then((d) => {
            if (!d.rating) return;
            const F = (v) => v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(v);
            const el = document.getElementById('douban');
            el.innerHTML = '<a class="douban" href="https://movie.douban.com/subject/' + d.id + '/" target="_blank" rel="noopener">豆瓣 <b>' + d.rating.toFixed(1) + '</b>' + (d.votes ? ' · ' + F(d.votes) + ' 人' : '') + '</a>';
            el.hidden = false;
          })
          .catch(() => {});
      })();
      </script>
      <div class="tags">${t.genres.map((g) => `<a href="/?type=${t.media_type}&genre=${g.id}">${esc(g.name)}</a>`).join('')}</div>
      ${e.tagline ? `<p class="alt">「${esc(e.tagline)}」</p>` : ''}
      <p class="ov">${esc(t.overview) || '暂无简介'}</p>
      ${e.imdb_id ? `<p class="alt">IMDb: <a href="https://www.imdb.com/title/${esc(e.imdb_id)}/" target="_blank" rel="noopener" style="color:var(--acc)">${esc(e.imdb_id)}</a></p>` : ''}
      <form class="fav" method="post" action="/api/favorites/${t.id}">
        <b>收藏</b>
        <select name="status">${Object.entries(STATUS)
          .map(([v, n]) => `<option value="${v}"${fav?.status === v ? ' selected' : ''}>${n}</option>`)
          .join('')}</select>
        <select name="rating">${options(Array.from({ length: 10 }, (_, i) => [10 - i, `${10 - i} 分`]), fav?.rating, '不打分')}</select>
        <button name="op" value="save">保存</button>
        ${fav ? '<button name="op" value="remove">移除</button>' : ''}
      </form>
    </div>
  </div>
  <h2>磁力资源</h2>
  <div id="mg" data-id="${t.id}"><button class="find" type="button">搜索资源</button></div>
  <script>
  (() => {
    const box = document.getElementById('mg');
    const E = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const S = (b) => b == null ? '—' : b >= 1e9 ? (b/1e9).toFixed(2)+' GB' : Math.round(b/1e6)+' MB';
    const TABS = [['', '全部'], ['1080', '1080'], ['2160', '2160']];
    const TV = ${isMovie ? 'false' : 'true'};
    let items = [], filtered = 0, live = false, curR = '', curG = '';
    // 剧集多一档"季"：合集（跨季整包）与认不出季的分列，不进任何一个季
    const inG = (m, g) => !g ? true
      : g === 'pack' ? m.pack
      : g === 'other' ? !m.season && !m.pack
      : m.season === Number(g);
    // 只有一个季就别摆父级行了——"全部"与它完全重合
    const groups = () => {
      const ss = [...new Set(items.filter((m) => m.season).map((m) => m.season))].sort((a, b) => a - b);
      const rest = [items.some((m) => m.pack) && ['pack', '合集'], items.some((m) => !m.season && !m.pack) && ['other', '其它']].filter(Boolean);
      return TV && ss.length + rest.length > 1 ? [['', '全部'], ...ss.map((n) => [String(n), 'S' + n]), ...rest] : [];
    };

    const row = (arr, cur, attr, cnt) => '<div class="mgtabs' + (attr === 'g' ? ' g' : '') + '">'
      + (attr === 'g' ? '<span class="gl">季</span>' : '')
      + arr.map(([k, t]) => '<button type="button" data-' + attr + '="' + k + '"' + (k === cur ? ' class="on"' : '')
          + '>' + t + ' <b>' + cnt(k) + '</b></button>').join('') + '</div>';

    const draw = () => {
      const gs = groups();
      const g = items.filter((m) => inG(m, curG));
      const list = curR ? g.filter((m) => m.res === curR) : g;
      box.innerHTML = (gs.length ? row(gs, curG, 'g', (k) => items.filter((m) => inG(m, k)).length) : '')
        + row(TABS, curR, 'r', (k) => k ? g.filter((m) => m.res === k).length : g.length)
        + '<p class="alt">' + (list.length ? '共 ' + list.length + ' 条，按匹配度与做种数排序' : '该分辨率暂无资源')
        + (filtered ? '，另滤除 ' + filtered + ' 条不相关结果' : '') + '</p>'
        + (list.length ? '<table class="mg">'
          + '<tr><th>名称</th><th>大小</th><th>做种</th><th>画质</th><th>来源</th><th>发布</th><th></th></tr>'
          + list.map((m) => '<tr' + (m.exact ? ' class="hit"' : '') + '>'
              + '<td class="n" title="' + E(m.title) + '">' + (m.sub ? '<b class="zh">中字</b>' : '') + E(m.title) + '</td>'
              + '<td>' + S(m.size) + '</td>'
              + '<td>' + (m.seeders ?? '—') + '</td>'
              + '<td>' + E(m.quality) + '</td>'
              + '<td>' + E(m.sources.join(' + ')) + '</td>'
              + '<td>' + E((m.publishedAt ?? '').slice(0, 10)) + '</td>'
              + '<td><button type="button" data-m="' + E(m.magnet) + '">复制</button></td></tr>').join('')
          + '</table>' : '');

      box.querySelectorAll('.mgtabs button').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.g !== undefined) curG = b.dataset.g; else curR = b.dataset.r;
          draw();
        };
      });
      box.querySelectorAll('button[data-m]').forEach((b) => {
        b.onclick = async () => {
          try { await navigator.clipboard.writeText(b.dataset.m); b.textContent = '已复制'; }
          catch { b.textContent = '复制失败'; }
          setTimeout(() => { b.textContent = '复制'; }, 1500);
        };
      });
    };

    box.querySelector('button').onclick = async () => {
      box.innerHTML = '<p class="alt">检索中…</p>';
      try {
        const r = await fetch('/api/magnets/' + box.dataset.id);
        if (!r.ok) throw new Error(r.status);
        ({ items, filtered, live } = await r.json());
      } catch { return void (box.innerHTML = '<p class="alt">检索失败，请稍后重试</p>'); }

      if (!items.length) return void (box.innerHTML = '<p class="alt">' + (live ? '索引中暂无该片资源' : '资源索引不可达，请稍后重试')
        + (filtered ? '（已滤除 ' + filtered + ' 条不相关结果）' : '') + '</p>');
      draw();
    };
  })();
  </script>
  ${cast}`;

  return layout({ title: t.title, q: '', tabs: tabs('', {}), body });
}

export function loginPage(failed) {
  const body = `<div class="login">
    <form method="post" action="/login">
      <h1>影视库</h1>
      ${failed ? '<p class="err">口令错误</p>' : ''}
      <input type="password" name="password" placeholder="访问口令" autofocus required>
      <button type="submit">进入</button>
    </form>
  </div>`;
  return layout({ title: '登录', q: '', body });
}

export function favoritesPage(items) {
  const body = `<h1 style="margin:0 0 14px;font-size:20px">收藏</h1>
    ${items.length ? `<div class="grid">${items.map(card).join('')}</div>` : '<div class="empty">还没有收藏</div>'}`;
  return layout({ title: '收藏', q: '', body });
}

const sel = (name, pairs, cur) =>
  `<select name="${name}">${pairs
    .map(([v, n]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(n)}</option>`)
    .join('')}</select>`;

const MODE_LABEL = { auto: '按时间表自动', on: '强制开启', off: '强制关闭' };
const PRESET_LABEL = { low: '低 · 5', mid: '中 · 10（官方默认）', high: '高 · 40' };

export function crawlerPage({ desired, state, alive }) {
  const s = state ?? {};
  const sch = desired.schedule ?? {};
  const net = s.net;
  const runText = !state ? '未知（agent 尚未上报）' : s.running ? '运行中' : '已停止';

  const facts = [
    `<span>爬虫 <b>${runText}</b></span>`,
    `<span>模式 <b>${esc(MODE_LABEL[desired.mode] ?? desired.mode)}</b></span>`,
    s.scalingFactor != null ? `<span>生效 scaling_factor <b>${s.scalingFactor}</b></span>` : '',
    s.torrents ? `<span>种子总量 <b>${s.torrents.total.toLocaleString()}</b></span>` : '',
    s.torrents ? `<span>昨日新增 <b>${s.torrents.yesterday.toLocaleString()}</b></span>` : '',
    `<span title="时区 ${esc(s.tz ?? 'Asia/Shanghai')}">当地时间 <b>${esc(s.bjTime ?? '—')}</b></span>`,
    s.nextChange ? `<span>下次切换 <b>${esc(s.nextChange)}</b></span>` : '',
    net ? `<span>网卡 ↓<b>${net.rxKBs}</b> ↑<b>${net.txKBs}</b> KB/s</span>` : '',
    net ? `<span>包速率 ↓<b>${net.rxPps}</b> ↑<b>${net.txPps}</b> pkt/s</span>` : '',
  ].filter(Boolean).join('');

  const body = `<h1 style="margin:0 0 14px;font-size:20px">DHT 爬虫控制台</h1>
    ${alive ? '' : '<p style="color:#ff6b6b;margin:0 0 14px">控制 agent 未响应（状态超过 30 秒未刷新）——下面的改动不会生效，检查 <code>systemctl --user status crawler-agent</code>。</p>'}
    <div class="facts">${facts}</div>
    ${s.error ? `<p style="color:#ff6b6b">agent 报错：${esc(s.error)}</p>` : ''}
    <form class="filters" method="post" action="/crawler">
      ${sel('mode', Object.entries(MODE_LABEL), desired.mode)}
      ${sel('preset', Object.entries(PRESET_LABEL), desired.preset)}
      <label><input type="checkbox" name="scheduleEnabled" value="1"${sch.enabled ? ' checked' : ''}> 启用时间段</label>
      <input type="time" name="start" value="${esc(sch.start ?? '01:00')}">
      <span>至</span>
      <input type="time" name="end" value="${esc(sch.end ?? '08:00')}">
      <button type="submit">保存</button>
    </form>
    <p class="alt">档位即 bitmagnet 的 <code>dht_crawler.scaling_factor</code>：并发与缓冲都乘以该值，是爬虫资源占用的总开关。官方默认 10，文档明写超过 10 收益递减。切换档位会重启爬虫容器；开关本身是秒级。</p>
    <p class="alt">时间段按北京时间判定。网卡速率是整块网卡的总流量（含机器上所有其他服务），不是爬虫单独的。种子总量与昨日新增每分钟从 bitmagnet 数据库取样一次，昨日按调度时区的自然日计。</p>`;

  return layout({ title: '爬虫', q: '', tabs: tabs('', {}, 'crawler'), body });
}
