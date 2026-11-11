(function () {
  var BASE = 'https://huangguoai.io';
  var PIC = 'https://pic.drleao.cn';
  var PAGE_SIZE = 20;
  var PLAY_WORKERS = [
    'https://huangguo-play.lsy972513547.workers.dev'
  ];
  var PLAY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
    'Referer': 'https://huangguoai.io/'
  };

  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  function clock(seconds) {
    var total = num(seconds, 0);
    if (total <= 0) return '';
    var m = Math.floor(total / 60);
    var s = Math.floor(total % 60);
    return (m < 10 ? '0' + m : String(m)) + ':' + (s < 10 ? '0' + s : String(s));
  }
  function absCover(url) {
    var s = str(url);
    if (!s) return '';
    if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return s;
    if (s.charAt(0) === '/') return PIC + s;
    return s;
  }

  async function getJson(ctx, path) {
    var res;
    try {
      res = await ctx.call('net', {
        url: BASE + path,
        headers: { 'Accept': 'application/json, text/plain, */*' }
      });
    } catch (e) {
      throw new Error('黄果接口请求失败 ' + path + '：' + ((e && e.message) || e));
    }
    if (!res || res.ok !== true) {
      throw new Error('黄果接口请求失败 ' + path + '：' + ((res && res.error) || '没有响应'));
    }
    var body = String(res.body == null ? '' : res.body);
    if (!body) throw new Error('黄果接口返回了空响应：' + path);
    var box;
    try { box = JSON.parse(body); } catch (e) {
      throw new Error('黄果接口返回的不是 JSON：' + path);
    }
    if (box && box.status !== undefined && Number(box.status) !== 1) {
      throw new Error('黄果接口报了 status=' + box.status + '：' + (box.msg || '') + '（' + path + '）');
    }
    return (box && box.data) || {};
  }

  function toCard(item) {
    if (!item || item.id == null) return null;
    var id = String(item.id);
    var episodes = num(item.episode_count, 0);
    return {
      id: id,
      title: str(item.title),
      cover: absCover(item.cover),
      badge: episodes > 0 ? (episodes + '集') : clock(item.duration),
      score: item.score == null ? '' : String(item.score),
      category: str(item.cate_name),
      episodeCount: episodes,
      duration: clock(item.duration)
    };
  }

  function cardsOf(list) {
    var out = [], seen = {};
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var card = toCard(arr[i]);
      if (!card || !card.id || seen[card.id]) continue;
      seen[card.id] = 1;
      out.push(card);
    }
    return out;
  }

  function moreOf(pagination, page, count) {
    var pages = num(pagination && pagination.pages, 0);
    if (pages > 0) return page < pages;
    return count >= PAGE_SIZE;
  }

  function pageOf(args) {
    var n = num(args && args.page, 1);
    return n < 1 ? 1 : n;
  }

  function splitRef(ref) {
    var raw = str(ref);
    var i = raw.indexOf(':');
    if (i < 0) return { id: raw, ep: 1 };
    return { id: raw.substring(0, i), ep: Math.max(1, num(raw.substring(i + 1), 1)) };
  }

  async function playViaWorker(ctx, id, ep) {
    var lastErr = '';
    for (var i = 0; i < PLAY_WORKERS.length; i++) {
      var base = PLAY_WORKERS[i].replace(/\/$/, '');
      var url = base + '/api/play?id=' + enc(id) + '&ep=' + enc(ep);
      try {
        var res = await ctx.call('net', {
          url: url,
          headers: { 'Accept': 'application/json' }
        });
        if (!res || res.ok !== true) {
          lastErr = (res && res.error) || ('HTTP ' + (res && res.status));
          continue;
        }
        var body = String(res.body || '');
        if (!body) { lastErr = 'empty'; continue; }
        var box = JSON.parse(body);
        var stream = str(box.url || (box.data && box.data.url) || '');
        if (stream) return stream;
        lastErr = 'no url';
      } catch (e) {
        lastErr = (e && e.message) || String(e);
      }
    }
    throw new Error('播放 Worker 失败：' + lastErr);
  }

  __spiderSite = {
    id: 'huangguo',
    name: '黄果短剧',
    version: 4,
    requires: '>=1',
    hosts: [
      'huangguoai.io',
      'huangguoai.com',
      'huangguo-play.lsy972513547.workers.dev'
    ],

    async home(ctx) {
      var data = await getJson(ctx, '/api/home');
      var items = cardsOf(data.featured).concat(cardsOf(data.latest));
      var recs = Array.isArray(data.cate_rec) ? data.cate_rec : [];
      for (var i = 0; i < recs.length; i++) {
        items = items.concat(cardsOf(recs[i] && recs[i].videos));
      }
      var out = [], seen = {};
      for (var j = 0; j < items.length; j++) {
        if (seen[items[j].id]) continue;
        seen[items[j].id] = 1;
        out.push(items[j]);
      }
      if (out.length === 0) throw new Error('黄果首页没解析到内容');
      return { items: out, page: 1, hasMore: false };
    },

    async category(ctx, args) {
      var cate = str((args && (args.slug || args.cateId || args.ref)) || '');
      var page = pageOf(args);
      if (!cate) throw new Error('黄果分类缺少 cate_id');
      var data = await getJson(ctx, '/api/videos?cate_id=' + enc(cate) + '&page=' + page + '&size=' + PAGE_SIZE);
      var items = cardsOf(data.items);
      if (items.length === 0 && page === 1) throw new Error('黄果分类「' + cate + '」第一页没有内容');
      return { items: items, page: page, hasMore: moreOf(data.pagination, page, items.length) };
    },

    async search(ctx, args) {
      var keyword = str((args && (args.keyword || args.q || args.ref)) || '');
      var page = pageOf(args);
      if (!keyword) throw new Error('黄果搜索词为空');
      var data = await getJson(ctx, '/api/search?q=' + enc(keyword) + '&page=' + page);
      var items = cardsOf(data.items);
      return { items: items, page: page, hasMore: moreOf(data.pagination, page, items.length) };
    },

    async detail(ctx, args) {
      var ref = splitRef(args && args.ref);
      var id = ref.id;
      if (!id) throw new Error('黄果详情缺少 ref');
      if (!/^\d+$/.test(id)) throw new Error('黄果详情 ref 不是数字 id：' + id);
      var data = await getJson(ctx, '/api/videos/' + enc(id));
      if (!data || data.id == null) throw new Error('黄果详情返回空（id=' + id + '）');
      var eps = Array.isArray(data.episodes) ? data.episodes : [];
      var episodes = [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i] || {};
        var no = num(ep.ep_num, i + 1);
        episodes.push({
          no: no,
          title: str(ep.title) || ('第' + no + '集'),
          line: 'default',
          ref: String(no),
          episodeNumber: no,
          duration: clock(ep.duration)
        });
      }
      if (episodes.length === 0) {
        episodes.push({ no: 1, title: '正片', line: 'default', ref: '1', episodeNumber: 1, duration: '' });
      }
      var counts = data.counts || {};
      var extra = {};
      if (counts.hot != null) extra.playCount = String(counts.hot);
      if (data.author && data.author.name) extra.uploader = str(data.author.name);
      return {
        id: String(data.id),
        title: str(data.title) || ('视频 ' + id),
        cover: str(data.cover),
        description: str(data.description),
        score: data.score == null ? '' : String(data.score),
        category: (data.breadcrumb && data.breadcrumb[0] && str(data.breadcrumb[0].name)) || '',
        tags: Array.isArray(data.tags) ? data.tags.map(str).filter(Boolean) : [],
        duration: clock(data.duration),
        extra: extra,
        episodes: episodes,
        episodeCount: episodes.length,
        lines: [{ line: 'default', name: '默认线路' }],
        related: []
      };
    },

    async play(ctx, args) {
      var ref = splitRef(args && args.ref);
      var id = ref.id;
      if (!id) throw new Error('黄果播放缺少 ref');
      try {
        var data = await getJson(ctx, '/api/videos/' + enc(id) + '/play?ep=' + ref.ep);
        var url = str(data.video_url);
        if (url) {
          return {
            url: url,
            headers: PLAY_HEADERS,
            alts: [{ line: '默认线路', url: url, headers: PLAY_HEADERS }],
            episodeNumber: ref.ep
          };
        }
      } catch (e) {}
      var stream = await playViaWorker(ctx, id, ref.ep);
      return {
        url: stream,
        headers: PLAY_HEADERS,
        alts: [{ line: '默认线路', url: stream, headers: PLAY_HEADERS }],
        episodeNumber: ref.ep
      };
    },

    async tags(ctx) {
      var data = await getJson(ctx, '/api/tags');
      var cats = Array.isArray(data.categories) ? data.categories : [];
      var out = [], seen = {};
      for (var i = 0; i < cats.length; i++) {
        var cat = cats[i] || {};
        var group = str(cat.code) || 'other';
        var list = Array.isArray(cat.tags) ? cat.tags : [];
        for (var j = 0; j < list.length; j++) {
          var tag = list[j] || {};
          var name = str(tag.name);
          var slug = str(tag.slug) || name;
          if (!name || !slug) continue;
          var key = group + '|' + slug;
          if (seen[key]) continue;
          seen[key] = 1;
          out.push({ name: name, slug: slug, group: group });
        }
      }
      if (out.length === 0) throw new Error('黄果标签接口没有内容');
      return { items: out };
    },

    async tagList(ctx, args) {
      var slug = str((args && (args.slug || args.label || args.ref)) || '');
      var page = pageOf(args);
      if (!slug) throw new Error('黄果标签为空');
      var data = await getJson(ctx, '/api/search?q=' + enc(slug) + '&page=' + page);
      var items = cardsOf(data.items);
      return { items: items, page: page, hasMore: moreOf(data.pagination, page, items.length) };
    }
  };
})();
