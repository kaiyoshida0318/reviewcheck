// ============================================
// reviewcheck Daily Fetch Script
// GitHub Actions から毎日 JST 06:00 に実行される
//
// 動作:
//   1. data/{shopId}/review_data.json を読む
//   2. 楽天 IchibaItem/Search を 1.2秒間隔でページング取得
//   3. productCache[code] の reviewCount / reviewAvg / lastFetched / reviewHistory[today] のみ更新
//   4. その他の既存フィールド (name / images / itemUrl / itemNumber / status / tags / memo など) は完全保持
//   5. ファイルを上書き保存(コミットは workflow 側で行う)
// ============================================

'use strict';

const fs = require('fs');
const path = require('path');

// ── 環境変数 ──
const APP_ID      = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY  = process.env.RAKUTEN_ACCESS_KEY;
const SHOP_CODE   = process.env.RAKUTEN_SHOP_CODE;
const SHOP_ID     = process.env.RAKUTEN_SHOP_ID || SHOP_CODE; // 未指定なら shopCode を流用

if (!APP_ID || !ACCESS_KEY || !SHOP_CODE) {
  console.error('❌ 必須環境変数が不足: RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_SHOP_CODE');
  process.exit(1);
}

// ── 設定 ──
const BASE = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const SAFE_INTERVAL = 1200;   // 楽天APIへのリクエスト間隔(ms)
const MAX_RATE_LIMIT = 3;     // 429が連続したら中断する回数
const DATA_FILE = path.join('data', SHOP_ID, 'review_data.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 今日の日付 (JST, YYYY-MM-DD) ──
function todayJST() {
  // GitHub Actions のランナーは UTC。JST に変換。
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── itemUrl から商品管理番号(code)を抜き出す ──
//   通常: https://item.rakuten.co.jp/{shop}/{code}/
//   アフィリエイト: https://hb.afl.rakuten.co.jp/.../?pc=https%3A%2F%2Fitem.rakuten.co.jp%2F{shop}%2F{code}%2F&...
function extractCode(itemUrl, shopCode) {
  if (!itemUrl) return null;
  try {
    let decoded = itemUrl;
    if (itemUrl.includes('hb.afl.rakuten.co.jp')) {
      const u = new URL(itemUrl);
      const pc = u.searchParams.get('pc');
      if (pc) decoded = decodeURIComponent(pc);
    }
    // item.rakuten.co.jp/{shopCode}/{code}/
    const m = decoded.match(new RegExp(`item\\.rakuten\\.co\\.jp/${shopCode}/([^/?]+)/?`));
    if (m) return m[1];
  } catch (e) {
    // フォールスルー
  }
  return null;
}

// ── 楽天API呼び出し ──
async function fetchPage(page) {
  const elements = 'itemName,itemCode,mediumImageUrls,itemUrl,reviewCount,reviewAverage';
  const url = `${BASE}?applicationId=${APP_ID}&accessKey=${ACCESS_KEY}&shopCode=${SHOP_CODE}&hits=30&page=${page}&sort=%2BitemPrice&format=json&elements=${elements}`;
  // v6.6.2: 楽天Web Service はOrigin/Referer両方を要求する場合がある
  // (REFERRER_MISSINGエラーは実際にはOriginヘッダで解決するケースが報告されている)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'reviewcheck-daily-fetch/6.6 (+https://kaiyoshida0318.github.io/reviewcheck/)',
      'Origin': 'https://kaiyoshida0318.github.io',
      'Referer': 'https://kaiyoshida0318.github.io/reviewcheck/'
    }
  });
  return res;
}

// ── メイン処理 ──
(async () => {
  const today = todayJST();
  console.log(`[daily-fetch] 開始: shopId=${SHOP_ID} / shopCode=${SHOP_CODE} / date=${today}`);

  // 既存データを読む(なければ空で開始)
  let store = { productCache: {}, monthlySales: {}, savedAt: null, version: 'v6.6' };
  if (fs.existsSync(DATA_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!store.productCache) store.productCache = {};
      if (!store.monthlySales) store.monthlySales = {};
      console.log(`[daily-fetch] 既存データ読み込み: ${Object.keys(store.productCache).length}件`);
    } catch (e) {
      console.error('[daily-fetch] 既存データ読み込み失敗:', e.message);
      process.exit(1);
    }
  } else {
    console.log('[daily-fetch] 既存データなし(新規)');
    // 親ディレクトリを作成
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  }

  // ── 楽天APIから全商品取得 ──
  let page = 1;
  let totalFetched = 0;
  let newCount = 0;
  let updateCount = 0;
  let rateLimitHits = 0;
  let hasMore = true;
  let fatalError = null;  // v6.6.1: API失敗を追跡

  while (hasMore && page <= 100) {
    try {
      const res = await fetchPage(page);

      if (res.status === 429) {
        rateLimitHits++;
        console.warn(`[daily-fetch] 429 rate limit (${rateLimitHits}/${MAX_RATE_LIMIT}). 5秒待機...`);
        if (rateLimitHits >= MAX_RATE_LIMIT) {
          console.error('[daily-fetch] 429多発で中断');
          fatalError = `Rate limit (429) ${MAX_RATE_LIMIT}回連続`;
          break;
        }
        await sleep(5000);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error(`[daily-fetch] HTTP ${res.status}: ${txt.slice(0, 300)}`);
        fatalError = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
        break;
      }

      const data = await res.json();
      const items = (data.Items || []).map(w => w.Item || w);

      if (items.length === 0) {
        // page=1 で 0件は異常(全商品が削除されたとは考えにくい)
        if (page === 1) {
          console.error('[daily-fetch] page=1 で 0件 — 異常');
          fatalError = 'page=1 で 0件取得';
        } else {
          console.log('[daily-fetch] アイテムなし — 正常終了(全ページ取得済み)');
        }
        break;
      }

      items.forEach(item => {
        const code = extractCode(item.itemUrl, SHOP_CODE);
        if (!code) {
          console.warn('[daily-fetch] code抽出失敗:', item.itemUrl);
          return;
        }

        // mediumImageUrls は [{ imageUrl: '...' }, ...] または ['...', ...]
        const rawImgs = item.mediumImageUrls || [];
        const targetImages = rawImgs.map(x => {
          const u = typeof x === 'string' ? x : (x && x.imageUrl) || '';
          // _ex=128x128 などのサムネ指定を外して大きめ画像にする
          return u.replace(/\?_ex=\d+x\d+/g, '');
        }).filter(Boolean);

        const directItemUrl = `https://item.rakuten.co.jp/${SHOP_CODE}/${code}/`;
        const newReviewCount = item.reviewCount || 0;

        if (!store.productCache[code]) {
          // 新規商品
          newCount++;
          store.productCache[code] = {
            name: item.itemName || '',
            images: targetImages,
            reviewCount: newReviewCount,
            reviewAvg: item.reviewAverage || 0,
            itemUrl: directItemUrl,
            lastFetched: new Date().toISOString(),
            itemNumber: null,
            reviewHistory: { [today]: newReviewCount },
          };
        } else {
          // 既存商品: レビュー件数・平均点・履歴のみ更新(name/itemNumber/status/tags/memo等は保持)
          updateCount++;
          const p = store.productCache[code];
          p.reviewCount = newReviewCount;
          p.reviewAvg = item.reviewAverage || 0;
          p.lastFetched = new Date().toISOString();
          // images と itemUrl は新規取得値で更新(古いURLが残るより新しい方が安全)
          p.images = targetImages;
          p.itemUrl = directItemUrl;
          // レビュー履歴
          if (!p.reviewHistory) p.reviewHistory = {};
          p.reviewHistory[today] = newReviewCount;
        }
      });

      totalFetched += items.length;
      console.log(`[daily-fetch] page ${page}: ${items.length}件 (累計 ${totalFetched})`);

      hasMore = items.length === 30 && (data.pageCount ? page < data.pageCount : true);
      page++;
      if (hasMore) await sleep(SAFE_INTERVAL);

    } catch (e) {
      console.error('[daily-fetch] fetch エラー:', e.message);
      fatalError = `Exception: ${e.message}`;
      break;
    }
  }

  // ── v6.6.1: エラー時はファイルを更新せずに異常終了 ──
  if (fatalError) {
    console.error(`[daily-fetch] ✗ エラー終了: ${fatalError}`);
    console.error('[daily-fetch] データファイルは更新せず、ジョブを失敗扱いにします');
    process.exit(1);
  }

  // 取得 0件でエラー無しは通常ありえないが念のため
  if (totalFetched === 0) {
    console.error('[daily-fetch] ✗ 取得件数 0 — 保存スキップ');
    process.exit(1);
  }

  // ── 保存 ──
  store.savedAt = new Date().toISOString();
  store.version = 'v6.6.2';
  store.lastAutoFetch = new Date().toISOString();  // 自動取得の最終時刻(reviewcheck側で表示用)
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');

  console.log(`[daily-fetch] ✓ 完了: 新規${newCount}件 / 更新${updateCount}件 / 合計${Object.keys(store.productCache).length}件`);
  console.log(`[daily-fetch] 保存先: ${DATA_FILE}`);
})().catch(e => {
  console.error('[daily-fetch] 致命的エラー:', e);
  process.exit(1);
});
