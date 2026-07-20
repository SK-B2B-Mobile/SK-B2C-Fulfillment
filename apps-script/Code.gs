/******************************************************
 * SK B2C Fulfillment — Google Apps Script v41
 * v41 핵심 수정:
 *   - ShipStation Webhook(SHIP_NOTIFY) 자동 등록 기능 추가
 *     → Settings에서 버튼 클릭 한 번으로 이 웹앱 URL을 ShipStation에
 *       webhook target으로 등록 → 배송 라벨 생성 시 자동 스캔 카운트 반영
 *     → 이전에는 handleSSWebhook_ 수신 로직만 있고 등록 절차가 없어서
 *       실제로는 작동하지 않고 있었음 (이번에 등록 기능 추가로 해결)
 * v40 핵심 수정:
 *   - PickAssign 시트 추가: 페이지 수 기준 다중 작업자 배정
 *     (PG 1개 = 총 페이지 수, 여러 작업자가 나눠서 Start/End)
 *   - PickLists 시트에 Pages 컬럼 추가
 * v39 핵심 수정:
 *   - TikTok CBT 서버 동기화 추가 (TT_Orders/TT_Progress/TT_SkuSingle/TT_SkuSet 시트)
 *     → 매니저가 매일 아침 레이블 PDF를 업로드하면 주문/트래킹/제품 정보가
 *       서버에 저장되고, 여러 작업자가 각자 기기에서 동시에 2단계 스캔
 *       (라벨→상품 바코드) 가능
 *     → 주문 완료 시 오늘자 TikTok CBT 픽리스트 scanned 카운트에 자동 반영
 *       (updateScanned_ 재사용 — 기존 KPI/DailySummary 로직 그대로 활용)
 *   - doGet: ttOrders / ttSkuMaster / ttProgress 조회 op 추가
 *   - doPost: ttUploadOrders / ttUploadSkuMaster / ttScanUpdate action 추가
 * v38 핵심 수정:
 *   - PREFIX_MAP: 1156 prefix 추가
 *   - upsertList_: active 행 보호 (scanned/times 덮어쓰기 방지)
 * v37 핵심 수정:
 *   - autoScanPoll: pollTikTokOrders_ 자동 호출 제거
 *     → TikTok CBT는 웹앱 Scan Station 수동 바코드 스캔으로 카운트
 *     → TT-5773... 자동 ScanLog 기록 문제 완전 해결
 * v36 핵심 수정:
 *   - fetchTikTokAwaitingOrders_: total_count probe 방식으로 재작성
 *     → AWAITING_SHIPMENT total_count 확인 후 정확한 페이지 수만 조회
 *     → fulfillment_type=FULFILLMENT_BY_SELLER 필터로 CBT만 카운트
 * v35 핵심 수정:
 *   - processWebhookOrder_: pickEnd gate 추가
 *     → pickEnd 없으면 (픽킹 미완료) Webhook 스캔 무시
 *     → pickEnd 있으면 (픽킹 완료) 정상 카운트
 *     → 오전 레이블 출력 시 자동 스캔 문제 완전 해결
 *
 * v34 핵심 수정:
 *   - fetchTikTokAwaitingOrders_ 복원 (v32에서 잘못 제거됨)
 *   - fetchSSOrders_에 TikTok CBT 집계 재통합
 *   - Fetch Orders 버튼 클릭 시 TikTok CBT 주문수 정상 표시
 * v32 핵심 수정:
 *   - 5773(ShipStation TikTok 채널) = TikTok CBT로 올바르게 매핑
 *   - fetchTikTokAwaitingOrders_ 제거 (불필요: 5773 주문은 ShipStation으로 집계)
 *   - Fetch Orders = ShipStation만 조회 (TikTok Shop API 별도 호출 불필요)
 * v25 핵심 수정:
 *   TikTok 공식 서명 규칙 완전 준수:
 *   sign = secret + path + ALL_query_params(정렬,sign/access_token 제외) + body(POST만) + secret
 *   → shop_cipher도 반드시 sign에 포함 (URL에 있는 모든 파라미터)
 *   → POST body도 sign에 포함
 *   시도 이력: v22(shop_cipher O, body X), v23(shop_cipher X, body X),
 *              v24(shop_cipher X, body O), v25(shop_cipher O, body O) ← 정답
 ******************************************************/

const SS_ID = '19uCCGp93QhcE24V9U8Pxj5kb2nDDAuBwY8XDe61qAqM';

const SHEET_LISTS   = 'PickLists';
const SHEET_LOG     = 'ScanLog';
const SHEET_SUMMARY = 'DailySummary';

// ShipStation API
const SS_API_BASE = 'https://ssapi.shipstation.com';

// 채널 prefix → category 매핑 (B2C 앱과 동일)
const PREFIX_MAP = [
  {p:'US-HMS-',    cat:'Official',   store:'Heimish'},
  {p:'GSU',        cat:'Official',   store:'Shein'},
  {p:'200014',     cat:'Official',   store:'Walmart'},
  {p:'TOCOBO-',    cat:'Official',   store:'Tocobo'},
  {p:'SKINFOOD-',  cat:'Official',   store:'Skinfood'},
  {p:'KAJA-',      cat:'Official',   store:'Kaja'},
  {p:'IDC-',       cat:'Official',   store:'I Dew Care'},
  {p:'jumiso-',    cat:'Official',   store:'Jumiso'},
  {p:'Betheskin-', cat:'Official',   store:'Be The Skin'},
  {p:'Hyaah-',     cat:'Official',   store:'Hyaah'},
  {p:'MD-',        cat:'Moida & Hola', store:'Moida US'},
  {p:'HOA',        cat:'Moida & Hola', store:'Hola'},
  {p:'5773',       cat:'TikTok CBT',   store:'TikTok'},  // ★ v32: 5773=TikTok CBT(seller-us.tiktok.com)
  {p:'1155',       cat:'TikTok CBT',   store:'TikTok'},
  {p:'1156',       cat:'TikTok CBT',   store:'TikTok'},  // ★ v38
  {p:'MBX',        cat:'Seeding',      store:'Seeding MBX'},
  {p:'RTN',        cat:'Seeding',      store:'Returns'},
];

/* ── Version ── */
const PROP = PropertiesService.getScriptProperties();
function _nowVer_() { return String(Date.now()); }
function getVersion_() {
  let v = PROP.getProperty('b2cVersion');
  if (!v) { v = _nowVer_(); PROP.setProperty('b2cVersion', v); }
  return v;
}
function bumpVersion_() { PROP.setProperty('b2cVersion', _nowVer_()); }

/* ════════════════════════════════════════
   HTTP ENTRY POINTS
════════════════════════════════════════ */
function doGet(e) {
  const op = (e && e.parameter && e.parameter.op) || '';
  if (op === 'ping')           return json_({ ok:true, pong:true, ts:Date.now() });
  if (op === 'getLists')       return json_(getLists_((e.parameter||{}).date||''));
  if (op === 'getScanLog')     return json_(getScanLog_((e.parameter||{}).date||''));
  if (op === 'getDailySummary')return json_(getDailySummary_((e.parameter||{}).date||today_()));
  if (op === 'ver')            return json_({ ok:true, ver:getVersion_() });

  // ★ ShipStation Webhook GET (연결 확인용)
  if (op === 'ssWebhookTest')  return json_({ ok:true, message:'SK B2C Webhook ready' });

  // ★ TikTok CBT 서버 동기화 (v39 추가)
  if (op === 'ttOrders')       return json_(ttGetOrders_((e.parameter||{}).date||''));
  if (op === 'ttSkuMaster')    return json_(ttGetSkuMaster_());
  if (op === 'ttProgress')     return json_(ttGetProgress_());

  // ★ Pick Assignments — 페이지 기준 다중 작업자 배정 (v40 추가)
  if (op === 'pickAssigns')    return json_(getPickAssigns_((e.parameter||{}).date||''));

  return json_({ ok:false, error:'unknown op: '+op });
}

/* ════════════════════════════════════════
   SHIPSTATION WEBHOOK 처리
════════════════════════════════════════ */
function handleSSWebhook_(data) {
  try {
    const resourceUrl = data.resource_url || data.resourceUrl || '';
    const resourceType = data.resource_type || data.resourceType || '';

    Logger.log('SS Webhook received: type=' + resourceType + ' url=' + resourceUrl);

    if (!resourceUrl) {
      const orderNum = data.orderNumber || data.order_number || '';
      if (orderNum) return processWebhookOrder_(orderNum);
      return { ok:false, error:'No resource_url or orderNumber' };
    }

    const key    = PROP.getProperty('SS_API_KEY')    || '';
    const secret = PROP.getProperty('SS_API_SECRET') || '';
    if (!key || !secret) return { ok:false, error:'No SS credentials' };

    const resp = UrlFetchApp.fetch(resourceUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':' + secret) },
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      return { ok:false, error:'SS API error: ' + resp.getResponseCode() };
    }

    const payload = JSON.parse(resp.getContentText());
    const orders = payload.orders || payload.shipments || [];
    let processed = 0;

    orders.forEach(order => {
      const orderNum = order.orderNumber || order.order_number || '';
      if (orderNum) {
        const r = processWebhookOrder_(orderNum);
        if (r.ok) processed++;
      }
    });

    return { ok:true, processed, message: processed + ' orders scanned via webhook' };

  } catch(e) {
    Logger.log('handleSSWebhook_ error: ' + e.message);
    return { ok:false, error: e.message };
  }
}

function processWebhookOrder_(orderNumber, skipSummary) {
  try {
    const detected = detectChannel_(orderNumber);
    if (!detected) {
      Logger.log('Unknown channel for order: ' + orderNumber);
      return { ok:false, error:'Unknown channel: ' + orderNumber };
    }

    const cat   = detected.cat;
    const store = detected.store;
    const date  = today_();

    const allLists = getLists_(today_());
    if (!allLists.ok || !allLists.lists) return { ok:false, error:'Failed to get lists' };

    // ★ v39 핵심 수정: pickEnd 있는 픽리스트만 candidates로 허용
    // pickEnd 없음 = 피킹 미완료 = 스캔 대상 아님
    const active = allLists.lists.filter(l =>
      l.category === cat &&
      l.status !== 'Complete' &&
      l.status !== 'Deleted' &&
      (l.orderCount || 0) > 0 &&
      l.pickEnd &&                          // ★ 추가: pickEnd 반드시 있어야 함
      String(l.pickEnd).trim() !== ''       // ★ 추가: 빈 문자열도 제외
    );

    if (active.length === 0) {
      // pickEnd 있는 픽리스트가 없으면 피킹 미완료 상태로 판단
      const anyPicking = allLists.lists.filter(l =>
        l.category === cat &&
        l.status !== 'Complete' &&
        l.status !== 'Deleted'
      );
      if (anyPicking.length === 0) {
        Logger.log('No pick list found for: ' + cat);
        return { ok:false, error:'No pick list for ' + cat };
      }
      Logger.log('⏸ 픽킹 미완료 — scanStart 기록 안 함: ' + cat);
      return { ok:false, reason:'picking_not_done', message:'Pick not completed yet for ' + cat };
    }

    // 오늘 날짜 픽리스트 우선
    const todayActive = active.filter(l => {
      const ld = l.date instanceof Date
        ? Utilities.formatDate(l.date, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(l.date).slice(0,10);
      return ld === date;
    });

    if (todayActive.length === 0) {
      Logger.log('⚠ 오늘(' + date + ') ' + cat + ' pickEnd 완료된 픽리스트 없음.');
      return { ok:false, error:'No completed-pick list for today: ' + cat };
    }

    const candidates = todayActive;
    const notFull = candidates.filter(l => (l.scanned || 0) < (l.orderCount || 0));
    const target = notFull.length > 0
      ? notFull[0]
      : candidates[candidates.length - 1];

    // ★ 이중 안전장치 (이 시점에서 pickEnd는 반드시 있어야 하지만 방어 코드 유지)
    if (!target.pickEnd || String(target.pickEnd).trim() === '') {
      Logger.log('⏸ Webhook 무시 (픽킹 미완료 — 이중 체크): ' + orderNumber + ' → ' + target.category + ' PG:' + target.pgNo);
      return { ok: false, reason: 'picking_not_done', message: 'Pick not completed yet — scan ignored' };
    }

    Logger.log('✅ Webhook matched: ' + orderNumber + ' → ' + target.category + ' PG:' + target.pgNo +
      ' date:' + target.date + ' (' + target.scanned + '/' + target.orderCount + ')' +
      ' pickEnd:' + target.pickEnd);
    return updateScanned_(target, orderNumber, store, skipSummary);

  } catch(e) {
    Logger.log('processWebhookOrder_ error: ' + e.message);
    return { ok:false, error: e.message };
  }
}
  

function updateScanned_(list, orderNumber, store, skipSummary) {
  const now = nowLocal_();
  const newScanned = (list.scanned || 0) + 1;
  const oc = list.orderCount || 0;

  const updated = {
    ...list,
    scanned: newScanned,
    scanStart: list.scanStart || now,
    scanEnd: (oc > 0 && newScanned >= oc) ? now : (list.scanEnd || null),
  };

  const r = upsertList_(updated, skipSummary);

  addScanLog_({
    barcode: orderNumber,
    cat: list.category,
    store: store,
    pgNo: list.pgNo,
    worker: list.worker || 'ShipStation',
    time: now,
  });

  Logger.log('✅ Webhook scanned: ' + orderNumber + ' → ' + list.category + ' ('+newScanned+'/'+oc+')');
  bumpVersion_();
  return { ok:true, pgNo: list.pgNo, category: list.category, scanned: newScanned };
}

function doPost(e) {
  let action='', data={};
  const ct=(e&&e.postData&&e.postData.type)||'';
  if(ct.indexOf('application/json')>=0 || ct.indexOf('text/plain')>=0){
    try{data=JSON.parse(e.postData.contents||'{}');}catch(_){data={};}
    action=(data.action||'').toString();
  } else {
    action=(e&&e.parameter&&e.parameter.action)||'';
    try{data=JSON.parse((e.parameter&&e.parameter.data)||'{}');}catch(_){data=e.parameter||{};}
  }

  if (!action && (data.resource_url || data.resource_type)) {
    Logger.log('Auto-detected ShipStation webhook payload');
    return json_(handleSSWebhook_(data));
  }

  switch(action){
    case 'upsertList':        return json_(upsertList_(data.list));
    case 'bulkLists':         return json_(bulkLists_(data.lists||[]));
    case 'addScanLog':        return json_(addScanLog_(data.entry));
    case 'bulkScanLog':       return json_(bulkScanLog_(data.entries||[]));
    case 'deleteList':        return json_(deleteList_(data.pgNo));
    case 'getDailySummary':   return json_(getDailySummary_(data.date||today_()));

    // ★ ShipStation 연동
    case 'fetchSSOrders':     return json_(fetchSSOrders_(data.apiKey, data.apiSecret, data.date));
    case 'verifySSOrder':     return json_(verifySSOrder_(data.apiKey, data.apiSecret, data.orderNumber));
    case 'saveSSCredentials': return json_(saveSSCredentials_(data.apiKey, data.apiSecret));
    case 'testSSConnection':  return json_(testSSConnection_(data.apiKey, data.apiSecret));
    case 'subscribeSSWebhook':return json_(subscribeSSWebhook_(data.apiKey, data.apiSecret));
    case 'listSSWebhooks':    return json_(listSSWebhooks_(data.apiKey, data.apiSecret));

    // ★ ShipStation Webhook
    case 'ssWebhook':         return json_(handleSSWebhook_(data));

    // ★ TikTok CBT 서버 동기화 (v39 추가) — 여러 작업자가 각자 기기에서 동시 스캔 가능하도록
    case 'ttUploadOrders':    return json_(ttUploadOrders_(data.orders||[], data.date));
    case 'ttUploadSkuMaster': return json_(ttUploadSkuMaster_(data.single||[], data.sets||[]));
    case 'ttScanUpdate':      return json_(ttScanUpdate_(data.orderId, data.lineScanned, data.scannedTrackingIds, data.status, data.worker));

    // ★ Pick Assignments — 페이지 기준 다중 작업자 배정 (v40 추가)
    case 'upsertPickAssign':  return json_(upsertPickAssign_(data.assign));
    case 'deletePickAssign':  return json_(deletePickAssign_(data.id));

    default: return json_({ ok:false, error:'unknown action: '+action });
  }
}

/* ════════════════════════════════════════
   SHIPSTATION API 연동
════════════════════════════════════════ */

/* ════════════════════════════════════════
   ShipStation Webhook 자동 등록 (v41 추가)
   ────────────────────────────────────────
   "On Orders Shipped (SHIP_NOTIFY)" 웹훅을 이 웹앱 URL로 등록한다.
   등록되면, ShipStation에서 배송 라벨이 생성될 때마다(=발송 처리)
   ShipStation이 자동으로 이 웹앱의 doPost를 호출 → handleSSWebhook_ →
   해당 오더의 채널을 감지해서 스캔 카운트를 자동으로 올려준다.
   ("Mark as Shipped"로 수동 처리한 주문은 이 웹훅이 발생하지 않음 — ShipStation 자체 제약)
════════════════════════════════════════ */
function listSSWebhooks_(apiKey, apiSecret) {
  const key    = apiKey    || PROP.getProperty('SS_API_KEY')    || '';
  const secret = apiSecret || PROP.getProperty('SS_API_SECRET') || '';
  if (!key || !secret) return { ok:false, error:'No API credentials. Please save them first.' };
  try {
    const resp = UrlFetchApp.fetch(SS_API_BASE + '/webhooks', {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':' + secret) },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return { ok:false, error:'HTTP '+resp.getResponseCode()+': '+resp.getContentText().slice(0,200) };
    const data = JSON.parse(resp.getContentText());
    return { ok:true, webhooks: data.webhooks || [] };
  } catch(e) { return { ok:false, error: e.message }; }
}

function subscribeSSWebhook_(apiKey, apiSecret) {
  const key    = apiKey    || PROP.getProperty('SS_API_KEY')    || '';
  const secret = apiSecret || PROP.getProperty('SS_API_SECRET') || '';
  if (!key || !secret) return { ok:false, error:'No API credentials. Please save them first.' };

  const targetUrl = ScriptApp.getService().getUrl();
  if (!targetUrl) return { ok:false, error:'웹앱 URL을 확인할 수 없습니다. 배포(Deploy) 상태를 확인하세요.' };

  // ★ 이미 같은 target_url로 SHIP_NOTIFY가 등록되어 있으면 중복 등록하지 않음
  const existing = listSSWebhooks_(key, secret);
  if (existing.ok) {
    const dup = (existing.webhooks || []).find(w =>
      String(w.event || '').toUpperCase() === 'SHIP_NOTIFY' &&
      String(w.target_url || '') === targetUrl
    );
    if (dup) return { ok:true, alreadyRegistered:true, message:'이미 등록되어 있습니다 (webhook id: '+(dup.webhook_id||dup.id)+')' };
  }

  try {
    const resp = UrlFetchApp.fetch(SS_API_BASE + '/webhooks/subscribe', {
      method: 'POST',
      contentType: 'application/json',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':' + secret) },
      payload: JSON.stringify({
        target_url: targetUrl,
        event: 'SHIP_NOTIFY',
        store_id: null,
        friendly_name: 'SK B2C Fulfillment — Auto Scan'
      }),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    if (code !== 200 && code !== 201) return { ok:false, error:'HTTP '+code+': '+resp.getContentText().slice(0,300) };
    return { ok:true, targetUrl, message:'SHIP_NOTIFY 웹훅이 등록되었습니다. 이제부터 ShipStation에서 배송 라벨을 만들면 자동으로 스캔 카운트가 올라갑니다.' };
  } catch(e) { return { ok:false, error: e.message }; }
}

function saveSSCredentials_(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) return { ok:false, error:'apiKey and apiSecret required' };
  PROP.setProperty('SS_API_KEY',    apiKey.trim());
  PROP.setProperty('SS_API_SECRET', apiSecret.trim());
  return { ok:true, message:'ShipStation credentials saved' };
}

function testSSConnection_(apiKey, apiSecret) {
  const key    = apiKey    || PROP.getProperty('SS_API_KEY')    || '';
  const secret = apiSecret || PROP.getProperty('SS_API_SECRET') || '';
  if (!key || !secret) return { ok:false, error:'No API credentials. Please save them first.' };

  try {
    const resp = UrlFetchApp.fetch(SS_API_BASE + '/stores?showInactive=false', {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':' + secret) },
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    if (code !== 200) return { ok:false, error:'HTTP '+code+': '+resp.getContentText().slice(0,200) };
    const stores = JSON.parse(resp.getContentText());
    return { ok:true, storeCount: stores.length, stores: stores.map(s=>({id:s.storeId, name:s.storeName})) };
  } catch(e) {
    return { ok:false, error: e.message };
  }
}



function fetchSSOrders_(apiKey, apiSecret, date) {
  const key    = apiKey    || PROP.getProperty('SS_API_KEY')    || '';
  const secret = apiSecret || PROP.getProperty('SS_API_SECRET') || '';
  if (!key || !secret) return { ok:false, error:'No ShipStation API credentials' };

  const targetDate = date || today_();

  try {
    let allOrders = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = SS_API_BASE + '/orders?orderStatus=awaiting_shipment&pageSize=500&page=' + page;
      const resp = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':' + secret) },
        muteHttpExceptions: true,
      });

      if (resp.getResponseCode() !== 200) {
        return { ok:false, error:'ShipStation API error: HTTP '+resp.getResponseCode() };
      }

      const data = JSON.parse(resp.getContentText());
      allOrders = allOrders.concat(data.orders || []);
      totalPages = data.pages || 1;
      page++;

    } while (page <= totalPages && page <= 10);

    Logger.log('Total orders fetched: ' + allOrders.length);

    const channelMap = {};
    const orderDetails = [];

    allOrders.forEach(order => {
      const orderNum = String(order.orderNumber || '');
      const detected = detectChannel_(orderNum);
      const cat   = detected ? detected.cat   : 'Unknown';
      const store = detected ? detected.store : 'Unknown';

      if (!channelMap[cat]) {
        channelMap[cat] = { category: cat, orderCount: 0, stores: {}, orders: [] };
      }
      channelMap[cat].orderCount++;
      channelMap[cat].stores[store] = (channelMap[cat].stores[store] || 0) + 1;
      channelMap[cat].orders.push(orderNum);
    });

    const summary = Object.values(channelMap).map(ch => ({
      category:   ch.category,
      orderCount: ch.orderCount,
      stores:     ch.stores,
      storeList:  Object.entries(ch.stores).map(([k,v]) => k+': '+v).join(', '),
    }));

    // ★ v34: TikTok CBT 주문 별도 조회 (seller-us.tiktok.com → ShipStation 미연동)
    const ttResult = fetchTikTokAwaitingOrders_();
    if (ttResult.ok && ttResult.count > 0) {
      // summary에 TikTok CBT 항목 추가 (또는 업데이트)
      const existing = summary.find(s => s.category === 'TikTok CBT');
      if (existing) {
        // ★ v37 fix: ShipStation 5773 건수를 TikTok API 정확한 값으로 대체 (+= 아님)
        existing.orderCount = ttResult.count;
        existing.storeList  = 'TikTok: ' + ttResult.count;
      } else {
        summary.push({
          category:   'TikTok CBT',
          orderCount: ttResult.count,
          stores:     { 'TikTok': ttResult.count },
          storeList:  'TikTok: ' + ttResult.count,
        });
      }
      Logger.log('✅ TikTok CBT awaiting orders: ' + ttResult.count);
    } else {
      Logger.log('TikTok CBT fetch result: ' + JSON.stringify(ttResult));
    }

    logSSFetch_(targetDate, summary);

    return {
      ok: true,
      date: targetDate,
      totalOrders: allOrders.length + (ttResult.ok ? ttResult.count : 0),
      summary: summary,
      tiktokCBTCount: ttResult.ok ? ttResult.count : 0,
      fetchedAt: nowLocal_(),
    };

  } catch(e) {
    Logger.log('fetchSSOrders_ error: ' + e.message);
    return { ok:false, error: e.message };
  }
}

function verifySSOrder_(apiKey, apiSecret, orderNumber) {
  const key    = apiKey    || PROP.getProperty('SS_API_KEY')    || '';
  const secret = apiSecret || PROP.getProperty('SS_API_SECRET') || '';
  if (!key || !secret) return { ok:false, error:'No API credentials' };
  if (!orderNumber)    return { ok:false, error:'orderNumber required' };

  try {
    const url = SS_API_BASE + '/orders?orderNumber=' + encodeURIComponent(orderNumber);
    const resp = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(key + ':' + secret) },
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      return { ok:false, error:'HTTP '+resp.getResponseCode() };
    }

    const data = JSON.parse(resp.getContentText());
    const orders = data.orders || [];
    if (orders.length === 0) return { ok:false, error:'Order not found: '+orderNumber };

    const o = orders[0];
    const detected = detectChannel_(orderNumber);
    return {
      ok: true,
      orderNumber: o.orderNumber,
      orderStatus: o.orderStatus,
      storeName:   o.storeName || '',
      category:    detected ? detected.cat   : 'Unknown',
      store:       detected ? detected.store : 'Unknown',
      itemCount:   (o.items || []).length,
      orderTotal:  o.orderTotal,
      recipient:   (o.shipTo || {}).name || '',
    };

  } catch(e) {
    return { ok:false, error: e.message };
  }
}

const IGNORE_PREFIXES = [
  'kpopglow',
];

function detectChannel_(orderNumber) {
  const upper = String(orderNumber).trim().toUpperCase();
  for (const ig of IGNORE_PREFIXES) {
    if (upper.startsWith(ig.toUpperCase())) return null;
  }
  for (const m of PREFIX_MAP) {
    if (upper.startsWith(m.p.toUpperCase())) return { cat: m.cat, store: m.store };
  }
  return null;
}

function logSSFetch_(date, summary) {
  try {
    const sh = getOrCreateSheet_('SSFetchLog', [
      'Fetched At', 'Date', 'Category', 'Order Count', 'Store Breakdown'
    ]);
    const now = nowLocal_();

    const lastRowBefore = sh.getLastRow();
    if (lastRowBefore >= 2) {
      const data = sh.getRange(2, 1, lastRowBefore - 1, 5).getValues();
      for (let i = data.length - 1; i >= 0; i--) {
        const rowDate = data[i][1] instanceof Date
          ? Utilities.formatDate(data[i][1], Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(data[i][1]).slice(0, 10);
        if (rowDate === date && String(data[i][2]).trim() === 'Unknown') {
          sh.deleteRow(i + 2);
          Logger.log('Deleted Unknown row at index: ' + (i + 2));
        }
      }
    }

    const existing = {};
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      const data = sh.getRange(2, 1, lastRow - 1, 5).getValues();
      data.forEach((r, i) => {
        const rowDate = r[1] instanceof Date
          ? Utilities.formatDate(r[1], Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(r[1]).slice(0, 10);
        const key = rowDate + '|' + String(r[2]);
        existing[key] = i + 2;
      });
    }

    summary.forEach(s => {
      const key = date + '|' + s.category;
      if (existing[key]) {
        const rowNum = existing[key];
        sh.getRange(rowNum, 1).setValue(now);
        sh.getRange(rowNum, 4).setValue(s.orderCount);
        sh.getRange(rowNum, 5).setValue(s.storeList);
        Logger.log('SSFetchLog updated: ' + key + ' → ' + s.orderCount);
      } else {
        sh.appendRow([now, date, s.category, s.orderCount, s.storeList]);
        Logger.log('SSFetchLog added: ' + key + ' → ' + s.orderCount);
      }
    });
  } catch(e) { Logger.log('logSSFetch_ error: ' + e.message); }
}

/* ════════════════════════════════════════
   SHEET HELPERS
════════════════════════════════════════ */
/* ════════════════════════════════════════
   PICK ASSIGNMENTS — 페이지 기준 다중 작업자 배정 (v40 추가)
   ────────────────────────────────────────
   PG(픽리스트) 하나에 총 페이지 수(pages)가 있고, 여러 작업자가
   나눠서(예: 6장 → 3명이 2장씩) 각자 Start/End를 눌러 작업한다.
   SKU를 일일이 세지 않고 "몇 장 픽킹했는지"로 속도/작업량을 측정한다.
════════════════════════════════════════ */
const SHEET_PICK_ASSIGN = 'PickAssign';
function pickAssignSheet_(){
  return getOrCreateSheet_(SHEET_PICK_ASSIGN, ['ID','PgNo','Date','Category','Worker','Pages','PickStart','PickEnd','Duration','CreatedAt','UpdatedAt']);
}

function upsertPickAssign_(a){
  if(!a||!a.pgNo||!a.worker) return { ok:false, error:'pgNo and worker required' };
  const lock=LockService.getDocumentLock(); lock.waitLock(15000);
  try{
    const sh=pickAssignSheet_(); const lastRow=sh.getLastRow();
    const id=a.id || (a.pgNo+'_'+a.worker+'_'+(a.date||today_()));
    let targetRow=0;
    if(lastRow>=2){
      const ids=sh.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0]));
      const idx=ids.indexOf(id);
      if(idx>=0) targetRow=idx+2;
    }
    const now=nowLocal_();
    const createdAt=targetRow ? sh.getRange(targetRow,10).getValue() : now;
    const row=[
      id, String(a.pgNo), a.date||today_(), String(a.category||''),
      String(a.worker), Number(a.pages)||0,
      fmtTime_(a.pickStart), fmtTime_(a.pickEnd),
      dur_(a.pickStart,a.pickEnd,a.date), createdAt, now
    ];
    if(targetRow) sh.getRange(targetRow,1,1,row.length).setValues([row]);
    else sh.appendRow(row);
    bumpVersion_();
    return { ok:true, id };
  }catch(e){ return { ok:false, error:e.message }; }
  finally{ lock.releaseLock(); }
}

function getPickAssigns_(date){
  const sh=pickAssignSheet_(); const lastRow=sh.getLastRow();
  if(lastRow<2) return { ok:true, assigns:[] };
  const data=sh.getRange(2,1,lastRow-1,11).getValues();
  const toDS=v=>{ if(!v) return ''; try{ const d=new Date(v); if(!isNaN(d.getTime())) return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd'); }catch(e){} return String(v).slice(0,10); };
  const assigns=data.filter(r=>!date||toDS(r[2])===date).map(r=>({
    id:String(r[0]), pgNo:String(r[1]), date:toDS(r[2]), category:String(r[3]),
    worker:String(r[4]), pages:Number(r[5])||0,
    pickStart:String(r[6]||''), pickEnd:String(r[7]||''), duration:String(r[8]||'')
  }));
  return { ok:true, assigns, ver:getVersion_() };
}

function deletePickAssign_(id){
  if(!id) return { ok:false, error:'id required' };
  const sh=pickAssignSheet_(); const lastRow=sh.getLastRow();
  if(lastRow<2) return { ok:false, error:'not found' };
  const ids=sh.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0]));
  const idx=ids.indexOf(String(id));
  if(idx<0) return { ok:false, error:'not found' };
  sh.deleteRow(idx+2);
  bumpVersion_();
  return { ok:true };
}

/* ════════════════════════════════════════
   TIKTOK CBT — 레이블/SKU 서버 동기화 (v39 추가)
   ────────────────────────────────────────
   TikTok CBT는 ShipStation에 주문이 잡히지 않아 매일 아침
   매니저가 레이블 PDF를 업로드하면(프런트에서 pdf.js로 파싱),
   그 결과(주문/트래킹/아이템)를 여기 서버에 저장한다.
   SKU Master(xlsx)도 마찬가지로 서버에 누적 저장(append-only merge).
   여러 작업자가 각자 기기에서 동시에 스캔할 수 있도록, 스캔 진행상황도
   (라벨 스캔 → 상품 바코드 스캔 2단계) 서버에 실시간 반영한다.
   주문이 완료(모든 라인 스캔) 처리되면, 오늘 날짜의 TikTok CBT
   픽리스트 scanned 카운트를 자동으로 +1 해서 기존 KPI/대시보드에
   그대로 반영되게 한다 (updateScanned_ 재사용).
════════════════════════════════════════ */
const SHEET_TT_ORDERS     = 'TT_Orders';
const SHEET_TT_PROGRESS   = 'TT_Progress';
const SHEET_TT_SKU_SINGLE = 'TT_SkuSingle';
const SHEET_TT_SKU_SET    = 'TT_SkuSet';

function ttOrdersSheet_()   { return getOrCreateSheet_(SHEET_TT_ORDERS,   ['OrderID','TrackingIDs','Buyer','ItemsJSON','Date','CreatedAt']); }
function ttProgressSheet_() { return getOrCreateSheet_(SHEET_TT_PROGRESS, ['OrderID','Status','LineScannedJSON','ScannedTrackingJSON','CompletedBy','CompletedTime','UpdatedAt']); }
function ttSkuSingleSheet_(){ return getOrCreateSheet_(SHEET_TT_SKU_SINGLE, ['SellerSKU','Barcode']); }
function ttSkuSetSheet_()   { return getOrCreateSheet_(SHEET_TT_SKU_SET,    ['SetSKU','ComponentSKU','Qty','ProductName','Status']); }

/* ── 주문 업로드 (레이블 PDF 파싱 결과) — 같은 Order ID면 트래킹/아이템 병합 ── */
function ttUploadOrders_(orders, date) {
  if (!Array.isArray(orders) || orders.length===0) return { ok:false, error:'orders required' };
  const lock = LockService.getDocumentLock(); lock.waitLock(15000);
  try {
    const sh = ttOrdersSheet_();
    const lastRow = sh.getLastRow();
    const existingIds = lastRow>=2 ? sh.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0])) : [];
    const now = nowLocal_();
    let added=0, merged=0;
    const newRows=[];
    orders.forEach(o=>{
      const idx = existingIds.indexOf(String(o.orderId));
      if (idx>=0) {
        const row = idx+2;
        const cur = sh.getRange(row,1,1,6).getValues()[0];
        const curTrack = String(cur[1]||'').split('|').filter(Boolean);
        const newTrack = Array.from(new Set([...curTrack, ...(o.trackingIds||[])]));
        let curItems=[]; try{ curItems=JSON.parse(cur[3]||'[]'); }catch(e){}
        (o.items||[]).forEach(it=>{
          const ex = curItems.find(x=>x.sellerSku===it.sellerSku);
          if (ex) ex.qty=(ex.qty||0)+(it.qty||0); else curItems.push(it);
        });
        sh.getRange(row,2).setValue(newTrack.join('|'));
        sh.getRange(row,4).setValue(JSON.stringify(curItems));
        merged++;
      } else {
        newRows.push([String(o.orderId), (o.trackingIds||[]).join('|'), String(o.buyer||''), JSON.stringify(o.items||[]), date||today_(), now]);
        existingIds.push(String(o.orderId));
        added++;
      }
    });
    if (newRows.length) sh.getRange(sh.getLastRow()+1,1,newRows.length,6).setValues(newRows);
    bumpVersion_();
    return { ok:true, added, merged };
  } catch(e){ return { ok:false, error:e.message }; }
  finally { lock.releaseLock(); }
}

function ttGetOrders_(date) {
  const sh = ttOrdersSheet_(); const lastRow = sh.getLastRow();
  if (lastRow<2) return { ok:true, orders:[] };
  const data = sh.getRange(2,1,lastRow-1,6).getValues();
  const toDS=v=>{ if(!v) return ''; try{ const d=new Date(v); if(!isNaN(d.getTime())) return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd'); }catch(e){} return String(v).slice(0,10); };
  const orders = data
    .filter(r=>!date || toDS(r[4])===date)
    .map(r=>{
      let items=[]; try{ items=JSON.parse(r[3]||'[]'); }catch(e){}
      return { orderId:String(r[0]), trackingIds:String(r[1]||'').split('|').filter(Boolean), buyer:String(r[2]||''), items, date:toDS(r[4]) };
    });
  return { ok:true, orders, ver:getVersion_() };
}

/* ── SKU 마스터 — append-only merge (검색 실패 시에만 보완, 기존 값은 절대 덮어쓰지 않음) ── */
function ttUploadSkuMaster_(single, sets) {
  const lock = LockService.getDocumentLock(); lock.waitLock(15000);
  try {
    let addedSingle=0, addedSet=0;
    if (Array.isArray(single) && single.length>0) {
      const sh = ttSkuSingleSheet_(); const lastRow=sh.getLastRow();
      const existing = lastRow>=2 ? sh.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0])) : [];
      const rows=[];
      single.forEach(s=>{
        if (!s.sku || existing.includes(String(s.sku))) return;
        rows.push([String(s.sku), String(s.barcode||'')]); existing.push(String(s.sku)); addedSingle++;
      });
      if (rows.length) sh.getRange(sh.getLastRow()+1,1,rows.length,2).setValues(rows);
    }
    if (Array.isArray(sets) && sets.length>0) {
      const sh = ttSkuSetSheet_(); const lastRow=sh.getLastRow();
      const existing = lastRow>=2 ? sh.getRange(2,1,lastRow-1,2).getValues().map(r=>r[0]+'|'+r[1]) : [];
      const rows=[];
      sets.forEach(s=>{
        const key=String(s.setSku)+'|'+String(s.componentSku);
        if (!s.setSku || !s.componentSku || existing.includes(key)) return;
        rows.push([String(s.setSku), String(s.componentSku), Number(s.qty)||1, String(s.productName||''), String(s.status||'')]);
        existing.push(key); addedSet++;
      });
      if (rows.length) sh.getRange(sh.getLastRow()+1,1,rows.length,5).setValues(rows);
    }
    bumpVersion_();
    return { ok:true, addedSingle, addedSet };
  } catch(e){ return { ok:false, error:e.message }; }
  finally { lock.releaseLock(); }
}

function ttGetSkuMaster_() {
  const shS = ttSkuSingleSheet_(); const lastS = shS.getLastRow();
  const single = lastS>=2 ? shS.getRange(2,1,lastS-1,2).getValues().map(r=>({sku:String(r[0]),barcode:String(r[1])})) : [];
  const shT = ttSkuSetSheet_(); const lastT = shT.getLastRow();
  const sets = lastT>=2 ? shT.getRange(2,1,lastT-1,5).getValues().map(r=>({setSku:String(r[0]),componentSku:String(r[1]),qty:Number(r[2])||1,productName:String(r[3]),status:String(r[4])})) : [];
  return { ok:true, single, sets };
}

/* ── 스캔 진행상황 (라벨 스캔 → 상품 바코드 스캔, 실시간 서버 동기화) ── */
function ttScanUpdate_(orderId, lineScanned, scannedTrackingIds, status, worker) {
  if (!orderId) return { ok:false, error:'orderId required' };
  const lock = LockService.getDocumentLock(); lock.waitLock(15000);
  try {
    const sh = ttProgressSheet_(); const lastRow = sh.getLastRow();
    const ids = lastRow>=2 ? sh.getRange(2,1,lastRow-1,1).getValues().map(r=>String(r[0])) : [];
    const idx = ids.indexOf(String(orderId));
    const now = nowLocal_();
    const row = [
      String(orderId), String(status||'in_progress'),
      JSON.stringify(lineScanned||{}), JSON.stringify(scannedTrackingIds||[]),
      status==='completed' ? String(worker||'') : '',
      status==='completed' ? now : '',
      now
    ];
    if (idx>=0) sh.getRange(idx+2,1,1,7).setValues([row]);
    else sh.appendRow(row);
    bumpVersion_();

    // ★ 완료 시 오늘 날짜 TikTok CBT 픽리스트의 scanned 카운트 자동 반영 (기존 KPI 대시보드 재사용)
    if (status==='completed') {
      const listsData = getLists_(today_());
      if (listsData.ok) {
        const target = listsData.lists.find(l =>
          l.category==='TikTok CBT' && l.status!=='Complete' && l.status!=='Deleted' &&
          l.pickEnd && (l.scanned||0) < (l.orderCount||0)
        );
        if (target) updateScanned_(target, orderId, 'TikTok CBT', false);
      }
    }
    return { ok:true };
  } catch(e){ return { ok:false, error:e.message }; }
  finally { lock.releaseLock(); }
}

function ttGetProgress_() {
  const sh = ttProgressSheet_(); const lastRow = sh.getLastRow();
  if (lastRow<2) return { ok:true, progress:{}, ver:getVersion_() };
  const data = sh.getRange(2,1,lastRow-1,7).getValues();
  const progress = {};
  data.forEach(r=>{
    let lineScanned={}, scannedTracking=[];
    try{ lineScanned=JSON.parse(r[2]||'{}'); }catch(e){}
    try{ scannedTracking=JSON.parse(r[3]||'[]'); }catch(e){}
    progress[String(r[0])] = { status:String(r[1]), lineScanned, scannedTrackingIds:scannedTracking, completedBy:String(r[4]||''), completedTime:String(r[5]||''), updatedAt:String(r[6]||'') };
  });
  return { ok:true, progress, ver:getVersion_() };
}

function ss_() { return SpreadsheetApp.openById(SS_ID); }

function getOrCreateSheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#1a1a3e').setFontColor('#E8E6FF');
    sh.setFrozenRows(1);
  }
  return sh;
}

function listsSheet_() {
  return getOrCreateSheet_(SHEET_LISTS, [
    'Date','PG No','Category','SKU','Order Count','Scanned',
    'Worker','Pick Start','Pick End','Scan Start','Scan End',
    'Pick Duration','Scan Duration','Status','Remarks','Skip Reason','Created At','Updated At','ID','Pages'
  ]);
}

/**
 * ★ PickLists 시트에 Pages(총 페이지 수) 컬럼이 없으면 맨 끝에 자동 추가 (v40)
 */
function ensurePagesColumn_() {
  const sh = listsSheet_();
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const hasPages = headers.some(h => String(h).trim() === 'Pages');
  if (!hasPages) {
    sh.getRange(1, lastCol + 1).setValue('Pages');
  }
}

/**
 * ★ PickLists 시트 컬럼 구조 자동 수정
 * Skip Reason 컬럼이 없으면 자동 삽입
 * GAS 에디터에서 한 번만 실행 (또는 upsertList_ 호출 시 자동)
 */
function ensureSkipReasonColumn() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LISTS);
  if (!sh) return;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const hasSkipReason = headers.some(h => String(h).toLowerCase().includes('skip'));
  if (!hasSkipReason) {
    // Remarks(O열=15번째) 오른쪽에 삽입
    const remarksIdx = headers.findIndex(h => String(h).toLowerCase().includes('remark'));
    const insertCol = remarksIdx >= 0 ? remarksIdx + 2 : 16;
    sh.insertColumnAfter(insertCol - 1);
    sh.getRange(1, insertCol).setValue('Skip Reason');
    Logger.log('✅ Skip Reason 컬럼 자동 삽입 at col ' + insertCol);
    SpreadsheetApp.getActiveSpreadsheet().toast('Skip Reason 컬럼 자동 삽입 완료!', '✅', 3);
  } else {
    Logger.log('Skip Reason 컬럼 이미 있음');
  }
}
function logSheet_()     { return getOrCreateSheet_(SHEET_LOG,     ['Time','Barcode','Category','Store','PG No','Worker','Date']); }
function summarySheet_() { return getOrCreateSheet_(SHEET_SUMMARY, ['Date','Category','Total SKU','Total Orders','Scanned','% Complete','Pick Start','Scan Start','Scan End','Workers','Lists Count']); }

/* ════════════════════════════════════════
   UTILS
════════════════════════════════════════ */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
// ★ v22 핵심 수정: Official 1/2 → Official 통합 이전에 시트에 이미 저장된 구 카테고리명 호환
function normalizeCat_(c) { c = String(c||''); return (c==='Official 1'||c==='Official 2') ? 'Official' : c; }
function nowLocal_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }
function fmtTime_(iso) {
  if(!iso) return '';
  try { const d=new Date(iso); if(isNaN(d))return iso; return Utilities.formatDate(d,Session.getScriptTimeZone(),'HH:mm:ss'); } catch(e){return String(iso);}
}
function dur_(s, e, listDate) {
  if(!s) return '';

  const attachDate = (val) => {
    if (!val) return null;
    const str = String(val).trim();

    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) {
      return new Date((listDate || today_()) + ' ' + str);
    }

    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
      return new Date(str);
    }

    try {
      const d = new Date(val);
      if (!isNaN(d)) {
        if (d.getFullYear() < 1970) {
          const base = listDate || today_();
          const hh = String(d.getHours()).padStart(2,'0');
          const mm = String(d.getMinutes()).padStart(2,'0');
          const ss = String(d.getSeconds()).padStart(2,'0');
          return new Date(base + ' ' + hh + ':' + mm + ':' + ss);
        }
        return d;
      }
    } catch(err) {}
    return null;
  };

  const start = attachDate(s);
  const end   = e ? attachDate(e) : new Date();
  if(!start || isNaN(start) || isNaN(end) || end <= start) return '';

  const WS = 8*60+30;
  const LS = 12*60;
  const LE = 13*60;
  const WE = 17*60+30;

  const toM = d => d.getHours()*60 + d.getMinutes();

  const dayWork = (sm, em) => {
    sm = Math.max(sm, WS); em = Math.min(em, WE);
    if(em <= sm) return 0;
    let m = 0;
    if(sm < LS) m += Math.min(em, LS) - sm;
    if(em > LE) m += em - Math.max(sm, LE);
    return Math.max(0, m);
  };

  let total = 0;
  let cur = new Date(start);
  let guard = 0;
  while(cur < end && guard++ < 400) {
    const y=cur.getFullYear(), mo=cur.getMonth(), d=cur.getDate();
    const nextDay = new Date(y, mo, d+1, 8, 30, 0);
    const sm = toM(cur);
    const em = (cur.toDateString()===end.toDateString()) ? toM(end) : WE;
    total += dayWork(sm, Math.min(em, WE));
    cur = nextDay;
    if(cur >= end) break;
  }

  if(total <= 0) return '';
  return total < 60 ? total+'m' : Math.floor(total/60)+'h '+(total%60)+'m';
}
function getSt_(l) {
  const oc=l.orderCount||0;
  if(oc>0&&l.scanned>=oc&&l.scanEnd)return 'Complete';
  if(l.scanStart)return 'Scanning'; if(l.pickEnd)return 'Pick Done'; if(l.pickStart)return 'Picking';
  return 'Pending';
}

/* ════════════════════════════════════════
   PICKLISTS CRUD
════════════════════════════════════════ */
function upsertList_(list, skipSummary) {
  if (!list || !list.pgNo) return { ok:false, error:'pgNo required' };
  const lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    ensurePagesColumn_();
    const sh = listsSheet_();
    const lastRow = sh.getLastRow();
    const date = list.date || today_();
    let targetRow = 0;
    if (lastRow >= 2) {
      const ids   = sh.getRange(2,19,lastRow-1,1).getValues().map(r=>String(r[0]));
      const pgNos = sh.getRange(2,2, lastRow-1,1).getValues().map(r=>String(r[0]));
      const dates = sh.getRange(2,1, lastRow-1,1).getValues().map(r=>String(r[0]));
      for (let i=0; i<pgNos.length; i++) {
        if (list.id && ids[i]===String(list.id))         { targetRow=2+i; break; }
        // ★ id 매칭 실패 시 pgNo+date로 폴백 (로컬 임시 id와 GAS id 불일치 대비)
        const dateVal = dates[i] instanceof Date
          ? Utilities.formatDate(dates[i], Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(dates[i]).slice(0,10);
        if (pgNos[i]===String(list.pgNo) && dateVal===String(date).slice(0,10)) { targetRow=2+i; break; }
      }
    }
    const now = nowLocal_();
    const createdAt = targetRow ? sh.getRange(targetRow,17).getValue() : now;

    // ★ v38: active 행 보호 — 기존 scanned > incoming이면 기존 유지, times도 보존
    let finalScanned = Number(list.scanned)||0;
    let finalPickStart = list.pickStart, finalPickEnd = list.pickEnd;
    let finalScanStart = list.scanStart, finalScanEnd = list.scanEnd;
    let finalPages = Number(list.pages)||0;
    if (targetRow) {
      const existingRow = sh.getRange(targetRow, 1, 1, 11).getValues()[0];
      const existingScanned = Number(existingRow[5])||0;
      if (existingScanned > finalScanned) finalScanned = existingScanned;
      if (!finalPickStart  && existingRow[7])  finalPickStart  = existingRow[7];
      if (!finalPickEnd    && existingRow[8])  finalPickEnd    = existingRow[8];
      if (!finalScanStart  && existingRow[9])  finalScanStart  = existingRow[9];
      if (!finalScanEnd    && existingRow[10]) finalScanEnd    = existingRow[10];
      if (!finalPages) { const existingPages = Number(sh.getRange(targetRow,20).getValue())||0; if (existingPages) finalPages = existingPages; }
    }

    const rowData = [
      date, String(list.pgNo||''), String(list.category||''),
      Number(list.sku)||0, Number(list.orderCount)||0, finalScanned,
      String(list.worker||''),
      fmtTime_(finalPickStart), fmtTime_(finalPickEnd),
      fmtTime_(finalScanStart), fmtTime_(finalScanEnd),
      dur_(finalPickStart,finalPickEnd,date), dur_(finalScanStart,finalScanEnd,date),
      getSt_({...list,scanned:finalScanned,pickStart:finalPickStart,pickEnd:finalPickEnd,scanStart:finalScanStart,scanEnd:finalScanEnd}),
      String(list.memo||''), String(list.skipReason||''), createdAt, now, String(list.id||''), finalPages
    ];
    // ★ id가 없으면 pgNo_date로 생성
    if (!rowData[18]) rowData[18] = String(list.pgNo||'') + '_' + String(date);
    if (targetRow) sh.getRange(targetRow,1,1,rowData.length).setValues([rowData]);
    else { sh.appendRow(rowData); }
    const row = targetRow || sh.getLastRow();
    const statusColors = {
      'Complete':  {bg:'#C6EFCE', tx:'#276221'},
      'Scanning':  {bg:'#BDD7EE', tx:'#1F4E79'},
      'Pick Done': {bg:'#DDEBF7', tx:'#2E5F8A'},
      'Picking':   {bg:'#FFEB9C', tx:'#9C6500'},
      'Pending':   {bg:'#F2F2F2', tx:'#595959'},
      'Deleted':   {bg:'#FFCCCC', tx:'#9C0006'},
    };
    const sc = statusColors[getSt_(list)] || {bg:null, tx:null};
    sh.getRange(row,1,1,18).setBackground(null).setFontColor(null);
    sh.getRange(row,14).setBackground(sc.bg).setFontColor(sc.tx).setFontWeight('bold');
    bumpVersion_();
    if (!skipSummary) updateDailySummary_(date);
    return { ok:true, row };
  } catch(e) { return { ok:false, error:e.message }; }
  finally { lock.releaseLock(); }
}

function bulkLists_(lists) {
  if (!Array.isArray(lists)||lists.length===0) return { ok:true, count:0 };
  let count=0;
  lists.forEach(l=>{ const r=upsertList_(l); if(r.ok)count++; });
  return { ok:true, count };
}

function deleteList_(pgNo, date) {
  if (!pgNo) return { ok:false, error:'pgNo required' };
  const sh=listsSheet_(); const lastRow=sh.getLastRow();
  if (lastRow<2) return { ok:false, error:'not found' };
  const pgNos=sh.getRange(2,2,lastRow-1,1).getValues();
  const dates=sh.getRange(2,1,lastRow-1,1).getValues();
  // ★ 중복 행 모두 삭제: pgNo 일치 + date 일치 (또는 date 없으면 pgNo만)
  let deleted=false;
  for (let i=0; i<pgNos.length; i++) {
    const pgMatch=String(pgNos[i][0])===String(pgNo);
    const dv = dates[i][0] instanceof Date
        ? Utilities.formatDate(dates[i][0], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(dates[i][0]).slice(0,10);
    const dateMatch=!date||dv===String(date).slice(0,10);
    if (pgMatch&&dateMatch) {
      const row=2+i;
      sh.getRange(row,14).setValue('Deleted');
      sh.getRange(row,17).setValue(nowLocal_());
      sh.getRange(row,1,1,17).setFontColor(null);
      sh.getRange(row,14).setBackground('#FFCCCC').setFontColor('#9C0006').setFontWeight('bold');
      deleted=true;
    }
  }
  if(deleted){bumpVersion_();return{ok:true};}
  return { ok:false, error:'not found: '+pgNo };
}

function getLists_(date) {
  const sh=listsSheet_(); const lastRow=sh.getLastRow();
  if (lastRow<2) return { ok:true, lists:[] };
  const lastCol=Math.max(sh.getLastColumn(),20);
  const data=sh.getRange(2,1,lastRow-1,lastCol).getValues();
  const toDS=val=>{if(!val&&val!==0)return'';try{const d=new Date(val);if(!isNaN(d.getTime()))return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd');}catch(e){}return String(val).slice(0,10);};
  const lists=data.filter(r=>{
    const rowDate=toDS(r[0]);
    return String(r[13])!=='Deleted'&&(!date||rowDate===date);
  }).map(r=>({
      date:toDS(r[0]),pgNo:String(r[1]),category:normalizeCat_(r[2]),
      sku:Number(r[3])||0,orderCount:Number(r[4])||0,scanned:Number(r[5])||0,
      worker:String(r[6]),pickStart:String(r[7]),pickEnd:String(r[8]),
      scanStart:String(r[9]),scanEnd:String(r[10]),pickDur:String(r[11]),
      scanDur:String(r[12]),status:String(r[13]),memo:String(r[14]),
      skipReason:String(r[15]),createdAt:String(r[16]),updatedAt:String(r[17]),id:String(r[18]),
      pages:Number(r[19])||0,
    }));
  return { ok:true, lists, ver:getVersion_() };
}

/* ════════════════════════════════════════
   SCAN LOG
════════════════════════════════════════ */
function addScanLog_(entry) {
  if (!entry||!entry.barcode) return { ok:false, error:'barcode required' };
  const sh=logSheet_();
  sh.appendRow([entry.time||nowLocal_(),String(entry.barcode),String(entry.cat||''),String(entry.store||''),String(entry.pgNo||''),String(entry.worker||''),today_()]);
  return { ok:true };
}
function bulkScanLog_(entries) {
  if (!Array.isArray(entries)||entries.length===0) return { ok:true, count:0 };
  const sh=logSheet_();
  const rows=entries.map(e=>[e.time||nowLocal_(),String(e.barcode||''),String(e.cat||''),String(e.store||''),String(e.pgNo||''),String(e.worker||''),String(e.time||'').slice(0,10)||today_()]);
  if(rows.length>0) sh.getRange(sh.getLastRow()+1,1,rows.length,7).setValues(rows);
  return { ok:true, count:rows.length };
}
function getScanLog_(date) {
  const sh=logSheet_(); const lastRow=sh.getLastRow();
  if (lastRow<2) return { ok:true, entries:[] };
  const data=sh.getRange(2,1,lastRow-1,7).getValues();
  const entries=data.filter(r=>!date||String(r[6])===date)
    .map(r=>({time:String(r[0]),barcode:String(r[1]),cat:String(r[2]),store:String(r[3]),pgNo:String(r[4]),worker:String(r[5]),date:String(r[6])}));
  return { ok:true, entries };
}

/* ════════════════════════════════════════
   DAILY SUMMARY
════════════════════════════════════════ */
function updateDailySummary_(date) {
  try {
    const listsData=getLists_(date);
    if (!listsData.ok) return;
    const lists=listsData.lists.filter(l=>l.status!=='Deleted');
    const sh=summarySheet_();
    const cats=['TikTok CBT','Official','Moida & Hola','Seeding','Reshipment'];

    const cleanTime=v=>{
      if(!v||v==='')return'';
      const s=String(v);
      if(/^\d{2}:\d{2}(:\d{2})?$/.test(s))return s;
      try{const d=new Date(v);if(!isNaN(d.getTime()))return Utilities.formatDate(d,Session.getScriptTimeZone(),'HH:mm:ss');}catch(e){}
      return s;
    };

    const rows=[];
    cats.forEach(cat=>{
      const cl=lists.filter(l=>l.category===cat);
      if (cl.length===0) return;
      const totalSKU=cl.reduce((a,l)=>a+(l.sku||0),0);
      const totalOrders=cl.reduce((a,l)=>a+(l.orderCount||0),0);
      const scanned=cl.reduce((a,l)=>a+(l.scanned||0),0);
      const pct=totalOrders>0?Math.round((scanned/totalOrders)*100)+'%':'0%';
      const pickStart=cl.map(l=>cleanTime(l.pickStart)).filter(Boolean).sort()[0]||'';
      const scanStart=cl.map(l=>cleanTime(l.scanStart)).filter(Boolean).sort()[0]||'';
      const scanEnd=cl.every(l=>l.status==='Complete')?cl.map(l=>cleanTime(l.scanEnd)).filter(Boolean).sort().slice(-1)[0]||'':'';
      const workers=[...new Set(cl.map(l=>l.worker).filter(Boolean))].join(', ');
      rows.push([date,cat,totalSKU,totalOrders,scanned,pct,pickStart,scanStart,scanEnd,workers,cl.length]);
    });
    if (rows.length===0) return;
    const lastRow=sh.getLastRow();
    if (lastRow>=2) {
      const dates=sh.getRange(2,1,lastRow-1,1).getValues();
      for (let i=dates.length-1;i>=0;i--) {
        const rowDate=dates[i][0] instanceof Date||String(dates[i][0]).includes(' ')
          ? (()=>{try{return Utilities.formatDate(new Date(dates[i][0]),Session.getScriptTimeZone(),'yyyy-MM-dd');}catch(e){return String(dates[i][0]).slice(0,10);}})()
          : String(dates[i][0]).slice(0,10);
        if(rowDate===date) sh.deleteRow(2+i);
      }
    }
    sh.getRange(sh.getLastRow()+1,1,rows.length,rows[0].length).setValues(rows);
  } catch(e) { Logger.log('updateDailySummary_ error: '+e.message); }
}
function getDailySummary_(date) {
  const sh=summarySheet_(); const lastRow=sh.getLastRow();
  if (lastRow<2) return { ok:true, summary:[] };
  const data=sh.getRange(2,1,lastRow-1,11).getValues();
  const summary=data.filter(r=>!date||String(r[0])===date)
    .map(r=>({date:String(r[0]),category:String(r[1]),totalSKU:Number(r[2])||0,totalOrders:Number(r[3])||0,scanned:Number(r[4])||0,pct:String(r[5]),pickStart:String(r[6]),scanStart:String(r[7]),scanEnd:String(r[8]),workers:String(r[9]),listsCount:Number(r[10])||0}));
  return { ok:true, summary };
}

/* ════════════════════════════════════════
   SETUP / TEST
════════════════════════════════════════ */
function setup() {
  listsSheet_(); logSheet_(); summarySheet_();
  getOrCreateSheet_('SSFetchLog', ['Fetched At','Date','Category','Order Count','Store Breakdown']);
  SpreadsheetApp.getActiveSpreadsheet().toast('SK B2C Fulfillment 시트가 생성되었습니다.', '✅ Setup Complete', 5);
  Logger.log('Setup complete. Sheets created: PickLists, ScanLog, DailySummary, SSFetchLog');
}

function applyStatusColors() {
  const sh = listsSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('No data'); return; }

  const statusColors = {
    'Complete':  {bg:'#C6EFCE', tx:'#276221'},
    'Scanning':  {bg:'#BDD7EE', tx:'#1F4E79'},
    'Pick Done': {bg:'#DDEBF7', tx:'#2E5F8A'},
    'Picking':   {bg:'#FFEB9C', tx:'#9C6500'},
    'Pending':   {bg:'#F2F2F2', tx:'#595959'},
    'Deleted':   {bg:'#FFCCCC', tx:'#9C0006'},
  };

  sh.getRange(2, 1, lastRow-1, 18)
    .setBackground(null)
    .setFontColor('#000000')
    .setFontWeight('normal');

  const statuses = sh.getRange(2, 14, lastRow-1, 1).getValues();
  statuses.forEach((r, i) => {
    const st = String(r[0]).trim();
    const sc = statusColors[st];
    const cell = sh.getRange(2+i, 14);
    if (sc) {
      cell.setBackground(sc.bg).setFontColor(sc.tx).setFontWeight('bold');
    } else {
      cell.setBackground(null).setFontColor('#000000').setFontWeight('normal');
    }
  });

  Logger.log('✅ 완료: ' + (lastRow-1) + '행 색상 적용');
  SpreadsheetApp.getActiveSpreadsheet().toast('Status 색상 적용 완료!', '✅ Done', 3);
}

function clearSheetColors() {
  const sh = listsSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows'); return; }
  sh.getRange(2, 1, lastRow - 1, 18).setBackground(null).setFontColor(null);
  Logger.log('✅ 색상 제거 완료: ' + (lastRow - 1) + '행');
  SpreadsheetApp.getActiveSpreadsheet().toast('PickLists 색상 초기화 완료!', '✅ Done', 3);
}

function runSummary() {
  const date = today_();
  updateDailySummary_(date);
  Logger.log('DailySummary updated for: ' + date);
  SpreadsheetApp.getActiveSpreadsheet().toast('DailySummary 업데이트 완료!', '✅ Done', 3);
}

function debugSummary() {
  const date = today_();
  Logger.log('=== DEBUG DailySummary ===');
  Logger.log('Target date: ' + date);

  const sh = listsSheet_();
  const lastRow = sh.getLastRow();
  Logger.log('Sheet lastRow: ' + lastRow);

  if (lastRow < 2) {
    Logger.log('Sheet is empty!');
    return;
  }

  const sample = sh.getRange(2, 1, Math.min(3, lastRow-1), 18).getValues();
  sample.forEach((r, i) => {
    const rawDate = r[0];
    const dateType = typeof rawDate;
    const isDate = rawDate instanceof Date;
    const formatted = isDate
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(rawDate).slice(0, 10);
    Logger.log('Row['+(i+2)+']: rawDate='+rawDate+' type='+dateType+' isDate='+isDate+' formatted='+formatted+' status='+r[13]);
  });

  const result = getLists_(date);
  Logger.log('getLists_ ok: ' + result.ok);
  Logger.log('Total lists fetched: ' + (result.lists ? result.lists.length : 0));

  const lists = (result.lists || []).filter(l => l.status !== 'Deleted');
  Logger.log('Non-deleted lists: ' + lists.length);

  const cats = ['TikTok CBT','Official','Moida & Hola','Seeding','Reshipment'];
  cats.forEach(cat => {
    const cl = lists.filter(l => l.category === cat);
    if (cl.length > 0) Logger.log('Category ['+cat+']: ' + cl.length + ' lists');
  });
}

function testSSConnectionDirect() {
  const key    = PROP.getProperty('SS_API_KEY')    || '';
  const secret = PROP.getProperty('SS_API_SECRET') || '';
  Logger.log('API Key: ' + (key ? key.slice(0,8)+'...' : 'NOT SET'));
  Logger.log('API Secret: ' + (secret ? '***SET***' : 'NOT SET'));
  const r = testSSConnection_(key, secret);
  Logger.log(JSON.stringify(r, null, 2));
}

/* ════════════════════════════════════════
   AUTO POLL — ShipStation Verified 주문 자동 스캔 카운트
   10분마다 실행 (GAS 타이머)
════════════════════════════════════════ */
function autoScanPoll() {
  const key    = PROP.getProperty('SS_API_KEY')    || '';
  const secret = PROP.getProperty('SS_API_SECRET') || '';
  if (!key || !secret) {
    Logger.log('autoScanPoll: No SS credentials');
    return;
  }

  const date = today_();
  Logger.log('=== autoScanPoll START: ' + date + ' ===');

  try {
    const verified = fetchVerifiedShipments_(key, secret, date);
    if (!verified.ok) {
      Logger.log('fetchVerifiedShipments_ failed: ' + verified.error);
      return;
    }
    Logger.log('Verified shipments today: ' + verified.shipments.length);

    if (verified.shipments.length === 0) {
      Logger.log('No verified shipments yet today');
      return;
    }

    const logData = getScanLog_(date);
    const alreadyScanned = new Set(
      (logData.entries || []).map(e => String(e.barcode))
    );
    Logger.log('Already scanned today: ' + alreadyScanned.size);

    const newShipments = verified.shipments.filter(s => {
      if (alreadyScanned.has(String(s.orderNumber))) return false;
      // TikTok CBT는 Scan Station 수동 스캔만 사용
      const detected = detectChannel_(String(s.orderNumber));
      const cat = detected ? detected.cat : null;
      if (cat === 'TikTok CBT') return false;
      return true;
    });
    Logger.log('New shipments to process: ' + newShipments.length);

    if (newShipments.length === 0) {
      Logger.log('No new shipments to process');
      return;
    }

    // ★ v39: 카테고리별 pickEnd 상태 미리 확인해서 로그 출력
    const allLists = getLists_(today_());
    if (allLists.ok && allLists.lists) {
      const cats = [...new Set(newShipments.map(s => {
        const d = detectChannel_(String(s.orderNumber));
        return d ? d.cat : null;
      }).filter(Boolean))];
      
      cats.forEach(cat => {
        const picking = allLists.lists.filter(l =>
          l.category === cat &&
          l.status !== 'Complete' &&
          l.status !== 'Deleted' &&
          String(l.date || '').slice(0, 10) === date
        );
        const withPickEnd = picking.filter(l => l.pickEnd && String(l.pickEnd).trim() !== '');
        Logger.log('카테고리 [' + cat + ']: 오늘 픽리스트 ' + picking.length + '개, pickEnd 완료 ' + withPickEnd.length + '개');
        if (withPickEnd.length === 0 && picking.length > 0) {
          Logger.log('⏸ [' + cat + '] 픽킹 미완료 — 이 카테고리 주문들은 스캔 처리 안 함');
        }
      });
    }

    let successCount = 0;
    let failCount = 0;
    let skippedPicking = 0;

    newShipments.forEach(s => {
      const r = processWebhookOrder_(s.orderNumber, true);
      if (r.ok) {
        successCount++;
        Logger.log('✅ Processed: ' + s.orderNumber + ' → ' + r.category + ' (' + r.scanned + ')');
      } else if (r.reason === 'picking_not_done') {
        skippedPicking++;
        // 픽킹 미완료는 정상적인 skip — 에러 아님
      } else {
        failCount++;
        Logger.log('⚠ Failed: ' + s.orderNumber + ' → ' + r.error);
      }
    });

    if (successCount > 0) {
      updateDailySummary_(date);
      bumpVersion_();
      Logger.log('DailySummary updated once after poll');
    }

    Logger.log('=== autoScanPoll DONE: success=' + successCount +
      ' skipped_picking=' + skippedPicking +
      ' fail=' + failCount + ' ===');

  } catch(e) {
    Logger.log('autoScanPoll error: ' + e.message);
  }
}

function fetchVerifiedShipments_(key, secret, date) {
  try {
    const authHeader = 'Basic ' + Utilities.base64Encode(key + ':' + secret);
    const targetDate = date || today_();

    Logger.log('fetchVerifiedShipments_ v40: modifyDate 기준, date=' + targetDate);

    let allOrders = [];
    let page = 1;
    let totalPages = 1;

    do {
      // ★ Orders API + modifyDate 기준 (Scan to Verify 시점 반영)
      const url = 'https://ssapi.shipstation.com/orders'
        + '?orderStatus=shipped'
        + '&modifyDateStart=' + targetDate + '%2000%3A00%3A00'
        + '&modifyDateEnd='   + targetDate + '%2023%3A59%3A59'
        + '&pageSize=500'
        + '&page=' + page;

      const resp = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: { 'Authorization': authHeader },
        muteHttpExceptions: true,
      });

      if (resp.getResponseCode() !== 200) {
        Logger.log('Orders API error: HTTP ' + resp.getResponseCode());
        return { ok:false, error:'Orders API HTTP ' + resp.getResponseCode() };
      }

      const data = JSON.parse(resp.getContentText());
      const orders = data.orders || [];

      // ★ orderNumber 있는 것만, voided 없음 (Orders API는 voided 필드 없음)
      const valid = orders.filter(o =>
        o.orderNumber &&
        String(o.orderNumber).trim() !== '' &&
        o.orderStatus === 'shipped'
      );

      // ★ autoScanPoll이 기대하는 {orderNumber} 형태로 변환
      allOrders = allOrders.concat(valid.map(o => ({
        orderNumber: o.orderNumber,
        shipDate:    o.shipDate || targetDate,
        modifyDate:  o.modifyDate || '',
      })));

      totalPages = data.pages || 1;
      page++;

      Logger.log('Orders API page ' + (page-1) + '/' + totalPages +
        ': ' + valid.length + '건 (누적: ' + allOrders.length + ')');

    } while (page <= totalPages && page <= 20);

    Logger.log('fetchVerifiedShipments_ v40 완료: 총 ' + allOrders.length + '건');
    return { ok:true, shipments: allOrders };

  } catch(e) {
    Logger.log('fetchVerifiedShipments_ v40 error: ' + e.message);
    return { ok:false, error: e.message };
  }
}


function setupAutoScanTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'autoScanPoll') {
      ScriptApp.deleteTrigger(t);
      Logger.log('Deleted existing trigger');
    }
  });

  ScriptApp.newTrigger('autoScanPoll')
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log('✅ autoScanPoll trigger set: every 10 minutes');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'autoScanPoll 10분마다 실행 설정 완료!', '✅ Trigger Set', 5
  );
}

function removeAutoScanTrigger() {
  let count = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'autoScanPoll') {
      ScriptApp.deleteTrigger(t);
      count++;
    }
  });
  Logger.log('Removed ' + count + ' trigger(s)');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    count + '개 트리거 삭제 완료', '✅ Done', 3
  );
}

function testAutoScanPoll() {
  autoScanPoll();
}

/* ════════════════════════════════════════
   TIKTOK SHOP CBT — 자동 폴링
   10분마다 오늘 IN_TRANSIT 주문 자동 스캔 카운트
════════════════════════════════════════ */

/**
 * ★ v37 최종 fix3:
 * TikTok sign 규칙: secret + path + URL_params(정렬) + body_json + secret
 * cursor → body에만 포함 (URL params에서 제거)
 *         → sign 계산 시 body를 통해서만 cursor 포함 (이중 포함 방지)
 * page_size → URL params에만 (body에서 제거)
 */
function fetchTikTokAwaitingOrders_() {
  try {
    const appKey      = PROP.getProperty('TT_APP_KEY')      || '';
    const appSecret   = PROP.getProperty('TT_APP_SECRET')   || '';
    const accessToken = PROP.getProperty('TT_ACCESS_TOKEN') || '';
    const shopCipher  = PROP.getProperty('TT_SHOP_CIPHER')  || '';

    if (!appKey || !appSecret || !accessToken || !shopCipher) {
      Logger.log('fetchTikTokAwaitingOrders_: credentials not set');
      return { ok:false, error:'TikTok credentials not set', count:0 };
    }

    // ★ 전용 호출 함수
    // - page_size: URL params only (body 제외)
    // - cursor:    body only (URL params 제외, sign은 body를 통해 포함)
    function callOrdersSearch_(pageSize, cursor, filters) {
      const timestamp = String(Math.floor(Date.now() / 1000));

      // body: filters + cursor (page_size 없음)
      const bodyObj = Object.assign({}, filters);
      if (cursor) bodyObj.cursor = cursor;
      const bodyJson = JSON.stringify(bodyObj);

      // sign params: URL에 들어가는 것들만 (cursor 없음, page_size만)
      const signParams = {
        app_key:     appKey,
        shop_cipher: shopCipher,
        page_size:   String(pageSize),
        timestamp:   timestamp,
      };
      // cursor는 signParams에 넣지 않음 → body_json에 포함되어 sign에 반영됨

      const sign = signTikTokRequest_('/order/202309/orders/search', signParams, appSecret, bodyJson);

      // URL: page_size만 (cursor 없음)
      const queryParts = [
        'app_key='      + encodeURIComponent(appKey),
        'shop_cipher='  + encodeURIComponent(shopCipher),
        'page_size='    + encodeURIComponent(String(pageSize)),
        'timestamp='    + encodeURIComponent(timestamp),
        'access_token=' + encodeURIComponent(accessToken),
        'sign='         + encodeURIComponent(sign),
      ];
      const url = 'https://open-api.tiktokglobalshop.com/order/202309/orders/search?' + queryParts.join('&');

      Logger.log('page_size=' + pageSize + ' cursor=' + (cursor ? cursor.slice(0,20)+'...' : '없음'));

      try {
        const resp = UrlFetchApp.fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
          payload: bodyJson,
          muteHttpExceptions: true,
        });
        const data = JSON.parse(resp.getContentText());
        if (data.code !== 0) {
          Logger.log('TikTok API error code=' + data.code + ' body=' + bodyJson.slice(0,100));
          return { ok:false, error:'TikTok error code ' + data.code };
        }
        return { ok:true, data: data.data };
      } catch(e) {
        return { ok:false, error: e.message };
      }
    }

    const filters = { order_status:'AWAITING_SHIPMENT', sort_field:'CREATE_TIME', sort_order:'DESC' };

    // Step 1: probe — total_count 확인
    const probeR = callOrdersSearch_(1, '', filters);
    if (!probeR.ok) return { ok:false, error: probeR.error, count:0 };

    const totalAwaiting = probeR.data.total_count || 0;
    if (totalAwaiting === 0) { Logger.log('total_count=0'); return { ok:true, count:0 }; }

    const maxPages = Math.min(Math.ceil(totalAwaiting / 50), 20);
    Logger.log('probe total_count=' + totalAwaiting + ' → maxPages=' + maxPages);

    // Step 2: 페이지 순회 + 중복 제거
    const seenIds = new Set();
    let cbtCount  = 0;
    let cursor    = '';
    let prevCursor = '__INIT__';
    let page      = 0;

    while (page < maxPages) {
      page++;
      const r = callOrdersSearch_(50, cursor, filters);
      if (!r.ok) { Logger.log('page ' + page + ' 오류: ' + r.error); break; }

      const orders = r.data.orders || r.data.order_list || [];
      if (orders.length === 0) { Logger.log('orders 0건 → 종료'); break; }

      let newCbt = 0;
      orders.forEach(o => {
        const oid = String(o.id || o.order_id || '');
        if (oid && seenIds.has(oid)) return;
        if (oid) seenIds.add(oid);
        if (o.fulfillment_type === 'FULFILLMENT_BY_SELLER') { cbtCount++; newCbt++; }
      });

      const nextCursor = r.data.next_page_token || '';
      Logger.log('page ' + page + '/' + maxPages + ': ' + orders.length + '건 (신규CBT+' + newCbt + '), 누적=' + cbtCount + ', 고유ID=' + seenIds.size);

      if (nextCursor && nextCursor === prevCursor) {
        Logger.log('cursor 반복 감지 → 중단'); break;
      }
      prevCursor = nextCursor;
      cursor = nextCursor;
      if (!cursor) { Logger.log('cursor 소진 → 정상 종료'); break; }
    }

    Logger.log('✅ TikTok CBT 최종: ' + cbtCount + '건 (고유주문 ' + seenIds.size + '건 / total_awaiting=' + totalAwaiting + ')');
    return { ok:true, count: cbtCount, orders:[] };

  } catch(e) {
    Logger.log('fetchTikTokAwaitingOrders_ exception: ' + e.message);
    return { ok:false, error: e.message, count:0 };
  }
}

/**
 * ★ 알고 있는 CBT 주문의 모든 필드 확인
 * 577325665620365636 = TikTok Shipping (Upgraded) CBT 확인된 주문
 */
function debugSpecificCBTOrder() {
  Logger.log('=== CBT 주문 필드 상세 확인 ===');

  // FULFILLMENT_BY_SELLER 전체 조회 후 알려진 CBT 주문 찾기
  const body = {
    order_status:     'AWAITING_SHIPMENT',
    fulfillment_type: 'FULFILLMENT_BY_SELLER',
    page_size:        50,
    sort_field:       'CREATE_TIME',
    sort_order:       'DESC',
  };

  const r = callTikTokAPI_('/order/202309/orders/search', body);
  if (!r.ok) { Logger.log('❌ ' + r.error); return; }

  const orders = r.data.orders || [];
  Logger.log('조회된 FULFILLMENT_BY_SELLER 주문: ' + orders.length + '건');

  // 모든 주문의 shipping 관련 필드 분포
  const fields = ['shipping_type','shipping_provider','delivery_option_name',
                  'delivery_option_id','delivery_type','payment_method_name'];

  fields.forEach(f => {
    const dist = {};
    orders.forEach(o => {
      const v = String(o[f] || 'null');
      dist[v] = (dist[v] || 0) + 1;
    });
    Logger.log(f + ' 분포: ' + JSON.stringify(dist));
  });

  // packages 필드 확인
  if (orders.length > 0) {
    Logger.log('--- 첫 주문 packages 필드 ---');
    Logger.log(JSON.stringify((orders[0].packages || []).slice(0,1)));
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Execution log 확인!', '✅ Debug', 5);
}
/**
 * 결과 = 21건과 다르면 이 함수로 실제 필드값 분포 확인
 */
function debugTikTokShippingFields() {
  Logger.log('=== debugTikTokShippingFields ===');

  // 전체 50건 조회 (1페이지)
  const body = {
    order_status: 'AWAITING_SHIPMENT',
    page_size:    50,
    sort_field:   'CREATE_TIME',
    sort_order:   'DESC',
  };

  const r = callTikTokAPI_('/order/202309/orders/search', body);
  if (!r.ok) { Logger.log('❌ ' + r.error); return; }

  const orders = r.data.orders || r.data.order_list || [];
  Logger.log('조회된 주문 수: ' + orders.length);

  // 각 필드별 분포 집계
  const distSP   = {}; // shipping_provider
  const distDON  = {}; // delivery_option_name
  const distDT   = {}; // delivery_type
  const distFT   = {}; // fulfillment_type
  const distWH   = {}; // warehouse_id

  orders.forEach((o, i) => {
    const sp  = String(o.shipping_provider  || 'null');
    const don = String(o.delivery_option_name || 'null');
    const dt  = String(o.delivery_type      || 'null');
    const ft  = String(o.fulfillment_type   || 'null');
    const wh  = String(o.warehouse_id       || 'null');

    distSP[sp]   = (distSP[sp]   || 0) + 1;
    distDON[don] = (distDON[don] || 0) + 1;
    distDT[dt]   = (distDT[dt]   || 0) + 1;
    distFT[ft]   = (distFT[ft]   || 0) + 1;
    distWH[wh]   = (distWH[wh]   || 0) + 1;

    // 처음 5건 상세 출력
    if (i < 5) {
      Logger.log('--- 주문 ' + (i+1) + ' (id:' + (o.id||o.order_id) + ') ---');
      Logger.log('  shipping_provider: '   + o.shipping_provider);
      Logger.log('  delivery_option_name: '+ o.delivery_option_name);
      Logger.log('  delivery_type: '       + o.delivery_type);
      Logger.log('  fulfillment_type: '    + o.fulfillment_type);
      Logger.log('  warehouse_id: '        + o.warehouse_id);
      Logger.log('  shipping_type: '       + o.shipping_type);
    }
  });

  Logger.log('=== 분포 집계 ===');
  Logger.log('shipping_provider 분포: '   + JSON.stringify(distSP));
  Logger.log('delivery_option_name 분포: '+ JSON.stringify(distDON));
  Logger.log('delivery_type 분포: '       + JSON.stringify(distDT));
  Logger.log('fulfillment_type 분포: '    + JSON.stringify(distFT));
  Logger.log('warehouse_id 분포: '        + JSON.stringify(distWH));

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Execution log에서 분포 확인! 21건과 맞는 필드를 찾으세요.', '✅ Debug Done', 8
  );
}

function setupTikTokCredentials() {
  // ★ v33: 구버전 앱(stylekoreanus) 으로 복구
  PROP.setProperty('TT_APP_KEY',      '6ah5hirk6clf0');
  PROP.setProperty('TT_APP_SECRET',   'e0abc0c2e0493fd84ee7accb38319a9c691a0797');
  PROP.setProperty('TT_SHOP_CIPHER',  'TTP_vpjPSAAAAACt576hEbNPzCY1J2oQ_2fD');
  PROP.setProperty('TT_SHOP_ID',      '7495299042298268268');
  PROP.setProperty('TT_TOKEN_TIME',   String(Date.now()));
  Logger.log('✅ TikTok credentials saved (stylekoreanus / 6ah5hirk6clf0)');
  Logger.log('👉 다음: saveTikTokAccessToken() 함수로 access_token 저장 필요');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'TikTok 기본 정보 저장 완료! saveTikTokAccessToken() 실행 필요', '✅ TikTok Setup', 5
  );
}

/**
 * ★ v34 디버그: TikTok 주문 상태별 카운트 확인
 * Run → Execution log에서 각 상태별 주문 수 확인
 */
function testTikTokOrderStatus() {
  Logger.log('=== TikTok Order Status Test ===');

  const statuses = [
    'AWAITING_SHIPMENT',
    'AWAITING_COLLECTION',
    'IN_TRANSIT',
    'PARTIALLY_SHIPPING',
    'ON_HOLD',
  ];

  for (const status of statuses) {
    const body = { order_status: status, page_size: 10 };
    const r = callTikTokAPI_('/order/202309/orders/search', body);
    if (r.ok) {
      const total = r.data.total || (r.data.orders || r.data.order_list || []).length;
      Logger.log(status + ': ' + total + '개');
    } else {
      Logger.log(status + ': ERROR - ' + r.error);
    }
    Utilities.sleep(500);
  }

  Logger.log('=== 완료 ===');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Execution log 확인하세요!', '✅ Test Done', 5
  );
}


/**
 * ★ v36: TikTok CBT 주문 수 조회 테스트 (FBT 제외 확인용)
 * Run → Execution log에서 FBT/CBT 분포 확인
 */
function testFetchTikTok() {
  Logger.log('=== testFetchTikTok (v36) ===');

  // 토큰 먼저 확인
  const tokenOk = checkTikTokToken();
  if (!tokenOk) {
    Logger.log('❌ 토큰 만료 → saveTikTokAccessToken() 실행 후 재시도');
    return;
  }

  const result = fetchTikTokAwaitingOrders_();

  if (result.ok) {
    Logger.log('✅ 결과: CBT 주문 = ' + result.count + '건');
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'CBT 주문: ' + result.count + '건 (Execution log에서 FBT/CBT 분포 확인)',
      '✅ testFetchTikTok', 8
    );
  } else {
    Logger.log('❌ 실패: ' + result.error);
    SpreadsheetApp.getActiveSpreadsheet().toast(
      '❌ 실패: ' + result.error, 'testFetchTikTok', 5
    );
  }
}


/**
 * ★ shop_cipher 강제 재저장 (연결 오류 시 실행)
 */
function resetTikTokShopCipher() {
  // API Testing Tool에서 확인한 최신 shop_cipher
  const CIPHER = 'TTP_vpjPSAAAAACt576hEbNPzCY1J2oQ_2fD';
  PROP.setProperty('TT_SHOP_CIPHER', CIPHER);
  Logger.log('✅ shop_cipher 재저장 완료: ' + CIPHER);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'shop_cipher 재저장 완료!', '✅ Done', 3
  );
}


function saveTikTokAccessToken() {
  // ★ 여기에 새 access_token 붙여넣기 (4시간마다 교체)
  const NEW_TOKEN = 'TTP_fIU4VwAAAAB02p4qcTCq8JQEfTq_NXQPkYcAmWMUeoFtT_9tvB4UVxFHy3cew50bYWeUWzZCWR2_xW_bZrdHzVrGBtXxL52HO73nWbnbcaKuGo3VVHrZHnlBkpQv_EandrZ2CwVPxmbEoHfZKwKc5b52Ym4nfjA6Tnc9G6zBp4eB4aZiKph-oQ';

  PROP.setProperty('TT_ACCESS_TOKEN', NEW_TOKEN);
  PROP.setProperty('TT_TOKEN_TIME',   String(Date.now()));
  Logger.log('✅ TikTok access_token saved at ' + new Date().toLocaleString());
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'TikTok Access Token 저장 완료! (4시간 유효)', '✅ Token Saved', 5
  );
}

/**
 * ★ v29: Refresh Token 저장 (최초 1회)
 * partner.tiktokshop.com → API Testing Tool
 * → Get shop authorization → 응답 JSON에서 refresh_token 복사
 */
function saveRefreshToken() {
  // ★ 여기에 refresh_token 붙여넣기
  const REFRESH_TOKEN = 'YOUR_REFRESH_TOKEN_HERE';

  if (REFRESH_TOKEN === 'YOUR_REFRESH_TOKEN_HERE') {
    Logger.log('❌ refresh_token을 입력해주세요!');
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'refresh_token을 saveRefreshToken() 함수에 입력 후 Run!', '⚠️ 입력 필요', 8
    );
    return;
  }
  PROP.setProperty('TT_REFRESH_TOKEN', REFRESH_TOKEN);
  PROP.setProperty('TT_REFRESH_TIME',  String(Date.now()));
  Logger.log('✅ Refresh token 저장 완료!');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Refresh Token 저장 완료! setupTikTokTokenRefreshTrigger() 실행하세요', '✅ Done', 5
  );
}

/**
 * ★ v29: TikTok Access Token 자동 갱신
 * refresh_token으로 새 access_token 발급
 * → 3.5시간마다 자동 실행 (setupTikTokTokenRefreshTrigger로 등록)
 */
function autoRefreshTikTokToken() {
  const appKey      = PROP.getProperty('TT_APP_KEY')      || '';
  const appSecret   = PROP.getProperty('TT_APP_SECRET')   || '';
  const refreshToken = PROP.getProperty('TT_REFRESH_TOKEN') || '';

  if (!refreshToken || refreshToken === 'YOUR_REFRESH_TOKEN_HERE') {
    Logger.log('❌ autoRefreshTikTokToken: refresh_token 없음. saveRefreshToken() 먼저 실행 필요');
    return { ok: false, error: 'No refresh_token' };
  }

  Logger.log('🔄 TikTok token 자동 갱신 시작...');

  const path      = '/authorization/202309/token/refresh';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyJson  = JSON.stringify({ refresh_token: refreshToken });

  const signParams = { app_key: appKey, timestamp };
  const sign = signTikTokRequest_(path, signParams, appSecret, bodyJson);

  const queryStr = [
    'app_key='   + encodeURIComponent(appKey),
    'timestamp=' + encodeURIComponent(timestamp),
    'sign='      + encodeURIComponent(sign),
  ].join('&');

  const url = 'https://open-api.tiktokglobalshop.com' + path + '?' + queryStr;

  try {
    const resp = UrlFetchApp.fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: bodyJson,
      muteHttpExceptions: true,
    });

    const text = resp.getContentText();
    Logger.log('Token refresh response: ' + text.slice(0, 300));
    const data = JSON.parse(text);

    if (data.code !== 0 || !data.data) {
      Logger.log('❌ Token refresh failed: ' + (data.message || 'code:' + data.code));
      // 갱신 실패 시 이메일 알림 (선택적)
      return { ok: false, error: data.message || 'code:' + data.code };
    }

    const newAccessToken  = data.data.access_token;
    const newRefreshToken = data.data.refresh_token || refreshToken; // refresh_token도 갱신될 수 있음

    PROP.setProperty('TT_ACCESS_TOKEN',  newAccessToken);
    PROP.setProperty('TT_TOKEN_TIME',    String(Date.now()));
    PROP.setProperty('TT_REFRESH_TOKEN', newRefreshToken);
    PROP.setProperty('TT_REFRESH_TIME',  String(Date.now()));

    Logger.log('✅ TikTok token 자동 갱신 성공! 새 토큰: ' + newAccessToken.slice(0, 20) + '...');
    return { ok: true };

  } catch(e) {
    Logger.log('❌ autoRefreshTikTokToken error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * ★ v29: 토큰 자동 갱신 트리거 등록 (3.5시간마다)
 * 최초 1회 실행하면 이후 자동 갱신됨
 */
function setupTikTokTokenRefreshTrigger() {
  // 기존 트리거 삭제
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'autoRefreshTikTokToken') {
      ScriptApp.deleteTrigger(t);
      Logger.log('기존 token refresh 트리거 삭제');
    }
  });

  // 새 트리거: 3.5시간(210분)마다 실행
  // GAS는 정확히 210분을 지원 안 하므로 120분(2시간)으로 설정 (더 안전)
  ScriptApp.newTrigger('autoRefreshTikTokToken')
    .timeBased()
    .everyMinutes(120)  // 2시간마다 (4시간 만료 전에 갱신)
    .create();

  Logger.log('✅ TikTok token 자동 갱신 트리거 등록 완료! (2시간마다)');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'TikTok 토큰 자동 갱신 설정 완료! (2시간마다)', '✅ Auto Refresh', 5
  );
}

/**
 * ★ v29: 토큰 자동 갱신 트리거 삭제
 */
function removeTikTokTokenRefreshTrigger() {
  let count = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'autoRefreshTikTokToken') {
      ScriptApp.deleteTrigger(t);
      count++;
    }
  });
  Logger.log('Removed ' + count + ' token refresh trigger(s)');
  SpreadsheetApp.getActiveSpreadsheet().toast(count + '개 토큰 갱신 트리거 삭제', '✅ Done', 3);
}

/**
 * ★ v24 핵심 수정: TikTok Shop API HMAC-SHA256 서명
 * POST 요청은 body(JSON 문자열)도 sign에 포함해야 함!
 *   GET:  secret + path + sorted_params + secret
 *   POST: secret + path + sorted_params + body_json + secret
 */
function signTikTokRequest_(path, queryParams, appSecret, bodyJson) {
  const filtered = Object.entries(queryParams)
    .filter(([k]) => k !== 'sign' && k !== 'access_token')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const paramStr = filtered.map(([k, v]) => k + String(v)).join('');

  // ★ v24: POST body가 있으면 params와 마지막 secret 사이에 포함
  const body = bodyJson || '';
  const toSign = appSecret + path + paramStr + body + appSecret;

  Logger.log('Sign params order: ' + filtered.map(([k]) => k).join(', '));
  Logger.log('Sign input FULL: ' + toSign.slice(0, 300));
  Logger.log('Body included in sign: ' + (body ? 'YES (' + body.length + ' chars)' : 'NO'));

  const raw = Utilities.computeHmacSha256Signature(toSign, appSecret, Utilities.Charset.UTF_8);
  const hex = raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  Logger.log('Sign result: ' + hex);
  return hex;
}

/**
 * ★ shop_cipher 동적으로 가져오기 (항상 최신값 사용)
 */
function getTikTokShopCipher_() {
  const appKey      = PROP.getProperty('TT_APP_KEY')      || '';
  const appSecret   = PROP.getProperty('TT_APP_SECRET')   || '';
  const accessToken = PROP.getProperty('TT_ACCESS_TOKEN') || '';

  const path      = '/authorization/202309/shops';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signParams = { app_key: appKey, timestamp };
  const sign = signTikTokRequest_(path, signParams, appSecret);

  const url = 'https://open-api.tiktokglobalshop.com' + path
    + '?app_key='      + encodeURIComponent(appKey)
    + '&timestamp='    + encodeURIComponent(timestamp)
    + '&sign='         + encodeURIComponent(sign)
    + '&access_token=' + encodeURIComponent(accessToken);

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { 'x-tts-access-token': accessToken },
      muteHttpExceptions: true,
    });
    const data = JSON.parse(resp.getContentText());
    if (data.code !== 0 || !data.data || !data.data.shops) {
      // ★ GET shops 실패 시 저장된 cipher 사용 (폴백)
      const storedCipher = PROP.getProperty('TT_SHOP_CIPHER') || '';
      Logger.log('getTikTokShopCipher_ failed (code:' + data.code + '): ' + (data.message||'') + ' → 저장된 cipher 사용: ' + storedCipher);
      return storedCipher;
    }
    const cipher = data.data.shops[0].cipher;
    Logger.log('Got fresh shop_cipher: ' + cipher);
    PROP.setProperty('TT_SHOP_CIPHER', cipher);
    return cipher;
  } catch(e) {
    Logger.log('getTikTokShopCipher_ error: ' + e.message);
    return PROP.getProperty('TT_SHOP_CIPHER') || '';
  }
}

/**
 * TikTok Shop API 호출 (POST) - v202309
 * shop_cipher를 동적으로 가져와서 sign에 포함
 */
function callTikTokAPI_(path, body) {
  const appKey      = PROP.getProperty('TT_APP_KEY')      || '';
  const appSecret   = PROP.getProperty('TT_APP_SECRET')   || '';
  const accessToken = PROP.getProperty('TT_ACCESS_TOKEN') || '';

  if (!appKey || !appSecret || !accessToken) {
    return { ok:false, error:'TikTok credentials not set.' };
  }

  // ★ v31 fix: 저장된 shop_cipher 직접 사용 (동적 조회 제거)
  // GET /authorization/202309/shops 가 불안정하므로 Script Properties 값 사용
  const shopCipher = PROP.getProperty('TT_SHOP_CIPHER') || '';
  if (!shopCipher) {
    return { ok:false, error:'shop_cipher not set. resetTikTokShopCipher() 실행 필요' };
  }
  Logger.log('Using stored shop_cipher: ' + shopCipher);

  const timestamp = String(Math.floor(Date.now() / 1000));

  // ★ v27 수정: page_size, cursor는 URL 쿼리 파라미터로 이동
  // TikTok POST: 페이지네이션 파라미터는 URL에, 필터 파라미터는 body에
  const pageSize = body.page_size || 50;
  const cursor   = body.cursor    || '';

  // sign 계산용 params (URL에 들어가는 모든 파라미터 포함)
  const signParamsBase = {
    app_key:     appKey,
    shop_cipher: shopCipher,
    page_size:   String(pageSize),
    timestamp:   timestamp,
  };
  if (cursor) signParamsBase.cursor = cursor;

  // body에서 페이지네이션 제거, 필터만 남김
  const bodyFilters = Object.assign({}, body);
  delete bodyFilters.page_size;
  delete bodyFilters.cursor;

  // order_status는 string으로 (TikTok API 요구)
  if (bodyFilters.order_status !== undefined) {
    bodyFilters.order_status = String(bodyFilters.order_status);
  }

  const bodyJson = JSON.stringify(bodyFilters);
  const sign = signTikTokRequest_(path, signParamsBase, appSecret, bodyJson);

  Logger.log('v27 URL params: page_size=' + pageSize + ' cursor=' + cursor);
  Logger.log('v27 body (filters only): ' + bodyJson);

  const queryParts = [
    'app_key='      + encodeURIComponent(appKey),
    'shop_cipher='  + encodeURIComponent(shopCipher),
    'page_size='    + encodeURIComponent(String(pageSize)),
    'timestamp='    + encodeURIComponent(timestamp),
    'access_token=' + encodeURIComponent(accessToken),
    'sign='         + encodeURIComponent(sign),
  ];
  if (cursor) queryParts.push('cursor=' + encodeURIComponent(cursor));
  const queryStr = queryParts.join('&');

  const url = 'https://open-api.tiktokglobalshop.com' + path + '?' + queryStr;
  Logger.log('TikTok URL: ' + url.slice(0, 300));

  try {
    const resp = UrlFetchApp.fetch(url, {
      method:             'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-tts-access-token': accessToken,
      },
      payload:            bodyJson,
      muteHttpExceptions: true,
    });

    const text = resp.getContentText();
    Logger.log('TikTok response: ' + text.slice(0, 500));
    const data = JSON.parse(text);

    if (data.code === 40105 || data.code === 40102 || data.code === 40001) {
      // ★ v29: 토큰 만료 시 자동 갱신 후 1회 재시도
      Logger.log('⚠️ Token expired (code:' + data.code + '), 자동 갱신 시도...');
      const refreshResult = autoRefreshTikTokToken();
      if (refreshResult.ok) {
        Logger.log('✅ 토큰 갱신 성공, API 재시도...');
        // 재귀 호출 대신 간단히 에러 반환 (다음 폴링 때 새 토큰으로 자동 성공)
        return { ok:false, error:'TOKEN_REFRESHED_RETRY_NEXT', code: data.code };
      }
      return { ok:false, error:'TOKEN_EXPIRED', code: data.code };
    }
    if (data.code !== 0) {
      return { ok:false, error:(data.message || 'code:' + data.code) };
    }
    return { ok:true, data: data.data || {} };

  } catch(e) {
    Logger.log('callTikTokAPI_ error: ' + e.message);
    return { ok:false, error: e.message };
  }
}

/**
 * TikTok 서명 디버그 테스트 (GET API)
 */
function debugTikTokSign() {
  const key     = PROP.getProperty('TT_APP_KEY')     || '';
  const secret  = PROP.getProperty('TT_APP_SECRET')  || '';
  const cipher  = PROP.getProperty('TT_SHOP_CIPHER') || '';
  const token   = PROP.getProperty('TT_ACCESS_TOKEN')|| '';
  Logger.log('App Key: ' + key);
  Logger.log('Secret: ' + secret.slice(0,8) + '...');
  Logger.log('Cipher: ' + cipher);
  Logger.log('Token: ' + token.slice(0,20) + '...');

  const path      = '/authorization/202309/shops';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signParams = { app_key: key, timestamp };
  const sign = signTikTokRequest_(path, signParams, secret);

  const url = 'https://open-api.tiktokglobalshop.com' + path
    + '?app_key=' + key
    + '&timestamp=' + timestamp
    + '&sign=' + encodeURIComponent(sign)
    + '&access_token=' + encodeURIComponent(token);

  Logger.log('Test URL: ' + url.slice(0, 200));

  const resp = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: { 'x-tts-access-token': token },
    muteHttpExceptions: true,
  });
  Logger.log('GET test response: ' + resp.getContentText().slice(0, 300));
}

/**
 * ★ v22 신규: POST sign 전용 디버그
 * 방법 A (shop_cipher 포함) vs 방법 B (shop_cipher 제외) 동시 테스트
 * → 어떤 방식이 맞는지 확인
 */
function debugTikTokSignPost() {
  const appKey      = PROP.getProperty('TT_APP_KEY')      || '';
  const appSecret   = PROP.getProperty('TT_APP_SECRET')   || '';
  const accessToken = PROP.getProperty('TT_ACCESS_TOKEN') || '';
  const shopCipher  = getTikTokShopCipher_();  // 최신 cipher 가져오기

  Logger.log('=== TikTok POST Sign Debug (v22) ===');
  Logger.log('App Key    : ' + appKey);
  Logger.log('Secret     : [' + appSecret + ']');
  Logger.log('Secret len : ' + appSecret.length + ' (정상: 40글자)');
  Logger.log('Cipher     : ' + shopCipher);
  Logger.log('Token      : ' + accessToken.slice(0, 30) + '...');

  const path    = '/order/202309/orders/search';
  const body    = { order_status: "IN_TRANSIT", page_size: 1 };

  // ─── 방법 A: shop_cipher 포함 ───
  const tsA = String(Math.floor(Date.now() / 1000));
  const signParamsA = { app_key: appKey, shop_cipher: shopCipher, timestamp: tsA };
  const signA = signTikTokRequest_(path, signParamsA, appSecret, JSON.stringify(body));
  const queryA = [
    'app_key='      + encodeURIComponent(appKey),
    'shop_cipher='  + encodeURIComponent(shopCipher),
    'timestamp='    + encodeURIComponent(tsA),
    'access_token=' + encodeURIComponent(accessToken),
    'sign='         + encodeURIComponent(signA),
  ].join('&');
  const urlA = 'https://open-api.tiktokglobalshop.com' + path + '?' + queryA;
  Logger.log('');
  Logger.log('▶ 방법 A (shop_cipher 포함) 호출...');
  Logger.log('URL A: ' + urlA.slice(0, 300));
  const respA = UrlFetchApp.fetch(urlA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  Logger.log('응답 A: ' + respA.getContentText().slice(0, 400));

  // ─── 방법 B: shop_cipher 제외 (sign에서만 제외, URL에는 포함) ───
  Utilities.sleep(1000); // timestamp 겹치지 않도록
  const tsB = String(Math.floor(Date.now() / 1000));
  const signParamsB = { app_key: appKey, timestamp: tsB };  // shop_cipher 없이 서명
  const signB = signTikTokRequest_(path, signParamsB, appSecret, JSON.stringify(body));
  const queryB = [
    'app_key='      + encodeURIComponent(appKey),
    'shop_cipher='  + encodeURIComponent(shopCipher),  // URL에는 포함
    'timestamp='    + encodeURIComponent(tsB),
    'access_token=' + encodeURIComponent(accessToken),
    'sign='         + encodeURIComponent(signB),
  ].join('&');
  const urlB = 'https://open-api.tiktokglobalshop.com' + path + '?' + queryB;
  Logger.log('');
  Logger.log('▶ 방법 B (shop_cipher 서명 제외) 호출...');
  Logger.log('URL B: ' + urlB.slice(0, 300));
  const respB = UrlFetchApp.fetch(urlB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  Logger.log('응답 B: ' + respB.getContentText().slice(0, 400));

  Logger.log('');
  Logger.log('=== 결과 요약 ===');
  const codeA = JSON.parse(respA.getContentText()).code;
  const codeB = JSON.parse(respB.getContentText()).code;
  Logger.log('방법 A code: ' + codeA + (codeA === 0 ? ' ✅ 성공!' : ' ❌ 실패'));
  Logger.log('방법 B code: ' + codeB + (codeB === 0 ? ' ✅ 성공!' : ' ❌ 실패'));
}

/**
 * 오늘 TikTok Shop IN_TRANSIT(배송 중) 주문 가져오기
 */
function fetchTikTokShippedOrders_(date) {
  try {
    const dayStart = new Date(date + 'T00:00:00');
    const dayEnd   = new Date(date + 'T23:59:59');
    const fromTs   = Math.floor(dayStart.getTime() / 1000);
    const toTs     = Math.floor(dayEnd.getTime()   / 1000);

    let allOrders = [];
    let cursor    = '';
    let hasMore   = true;
    let page      = 0;

    while (hasMore && page < 10) {
      page++;
      const body = {
        order_status:     "IN_TRANSIT",
        update_time_from: fromTs,
        update_time_to:   toTs,
        page_size:        100,
        sort_field:       'UPDATE_TIME',
        sort_order:       'DESC',
      };
      if (cursor) body.cursor = cursor;

      const r = callTikTokAPI_('/order/202309/orders/search', body);
      if (!r.ok) return r;

      const orders = (r.data.orders || r.data.order_list || []);
      cursor       = r.data.next_cursor  || r.data.next_page_token || '';
      // ★ v34 fix: cursor가 있으면 다음 페이지 존재
      hasMore      = cursor !== '';
      if (!cursor) hasMore = false;

      allOrders = allOrders.concat(orders);
      Logger.log('TikTok page ' + page + ': ' + orders.length + ' orders, hasMore=' + hasMore);
    }

    Logger.log('fetchTikTokShippedOrders_: total=' + allOrders.length + ' for ' + date);
    return { ok:true, orders: allOrders };

  } catch(e) {
    return { ok:false, error: e.message };
  }
}

/**
 * TikTok CBT 자동 폴링 메인 함수
 */
function pollTikTokOrders_(date) {
  Logger.log('--- pollTikTokOrders_ START: ' + date + ' ---');

  const result = fetchTikTokShippedOrders_(date);
  if (!result.ok) {
    if (result.error === 'TOKEN_EXPIRED') {
      Logger.log('⚠️ TikTok token expired! 새 토큰 발급 후 saveTikTokAccessToken() 실행 필요');
    } else {
      Logger.log('pollTikTokOrders_ failed: ' + result.error);
    }
    return { ok:false, error: result.error };
  }

  if (result.orders.length === 0) {
    Logger.log('No TikTok IN_TRANSIT orders today');
    return { ok:true, processed: 0 };
  }

  const logData        = getScanLog_(date);
  const alreadyScanned = new Set(
    (logData.entries || []).map(e => String(e.barcode))
  );
  Logger.log('TikTok already scanned today: ' + alreadyScanned.size);

  const newOrders = result.orders.filter(o => {
    const orderId = 'TT-' + String(o.id || o.order_id || '');
    return !alreadyScanned.has(orderId);
  });
  Logger.log('TikTok new orders to process: ' + newOrders.length);

  if (newOrders.length === 0) {
    Logger.log('No new TikTok orders to process');
    return { ok:true, processed: 0 };
  }

  const allLists = getLists_('');
  if (!allLists.ok || !allLists.lists) return { ok:false, error:'Failed to get lists' };

  const tiktokLists = allLists.lists.filter(l =>
    l.category === 'TikTok CBT' &&
    l.status   !== 'Complete'   &&
    l.status   !== 'Deleted'    &&
    (l.orderCount || 0) > 0
  );

  if (tiktokLists.length === 0) {
    Logger.log('No active TikTok CBT pick list found');
    return { ok:false, error:'No active TikTok CBT pick list' };
  }

  const todayLists = tiktokLists.filter(l => String(l.date).slice(0,10) === date);
  const candidates = todayLists.length > 0 ? todayLists : tiktokLists;

  let successCount = 0;
  let failCount    = 0;

  newOrders.forEach(o => {
    const orderId  = 'TT-' + String(o.id || o.order_id || '');
    const notFull  = candidates.filter(l => (l.scanned || 0) < (l.orderCount || 0));
    const target   = notFull.length > 0 ? notFull[0] : candidates[candidates.length - 1];

    if (!target) { failCount++; return; }

    const r = updateScanned_(target, orderId, 'TikTok', true);
    if (r.ok) {
      successCount++;
      Logger.log('✅ TikTok scanned: ' + orderId + ' → ' + target.pgNo + ' (' + r.scanned + ')');
    } else {
      failCount++;
      Logger.log('⚠️ TikTok failed: ' + orderId + ' → ' + r.error);
    }
  });

  Logger.log('--- pollTikTokOrders_ DONE: success=' + successCount + ' fail=' + failCount + ' ---');
  return { ok:true, processed: successCount };
}

/**
 * TikTok 연결 테스트 (수동 실행)
 */
/**
 * TikTok 토큰 만료 여부 확인
 * Run → log에서 토큰 상태 확인
 */
/**
 * TikTok 토큰 만료 여부 확인 + 만료 30분 전 이메일 알림
 */
function checkTikTokToken() {
  const token     = PROP.getProperty('TT_ACCESS_TOKEN') || '';
  const tokenTime = Number(PROP.getProperty('TT_TOKEN_TIME') || 0);
  const now       = Date.now();
  const elapsedMs = now - tokenTime;
  const elapsedH  = (elapsedMs / 1000 / 60 / 60).toFixed(1);
  const EXPIRE_MS = 4 * 60 * 60 * 1000;      // 4시간
  const WARN_MS   = 3.5 * 60 * 60 * 1000;    // 3.5시간 (만료 30분 전)
  const remainMin = Math.max(0, Math.round((EXPIRE_MS - elapsedMs) / 60000));

  Logger.log('=== TikTok Token Check ===');
  Logger.log('Token   : ' + token.slice(0, 30) + '...');
  Logger.log('Saved   : ' + new Date(tokenTime).toLocaleString());
  Logger.log('Elapsed : ' + elapsedH + '시간 (남은시간: ' + remainMin + '분)');

  if (elapsedMs > EXPIRE_MS) {
    // ★ 만료됨 → 이메일 알림
    Logger.log('⚠️ 토큰 만료!');
    sendTokenAlertEmail_('만료', 0);
    SpreadsheetApp.getActiveSpreadsheet().toast(
      '⚠️ TikTok 토큰 만료! 새 토큰 발급 필요 → saveTikTokAccessToken() 실행',
      '🔴 Token Expired', 10
    );
    return false;

  } else if (elapsedMs > WARN_MS) {
    // ★ 만료 30분 전 → 경고 이메일
    Logger.log('⚠️ 토큰 만료 ' + remainMin + '분 전! 미리 갱신 권장');
    sendTokenAlertEmail_('경고', remainMin);
    SpreadsheetApp.getActiveSpreadsheet().toast(
      '⚠️ TikTok 토큰 ' + remainMin + '분 후 만료! 미리 갱신하세요',
      '🟡 Token Warning', 8
    );
    return true;

  } else {
    Logger.log('✅ 토큰 유효 (발급 후 ' + elapsedH + '시간, ' + remainMin + '분 남음)');
    SpreadsheetApp.getActiveSpreadsheet().toast(
      '✅ 토큰 유효 (' + remainMin + '분 남음)',
      'Token OK', 3
    );
    return true;
  }
}

/**
 * 토큰 만료 이메일 알림 (GAS 실행 계정으로 발송)
 */
function sendTokenAlertEmail_(type, remainMin) {
  try {
    const email   = Session.getActiveUser().getEmail();
    const subject = type === '만료'
      ? '[SK B2C] TikTok 토큰 만료! 즉시 갱신 필요'
      : '[SK B2C] TikTok 토큰 ' + remainMin + '분 후 만료 예정';
    const guide = '1. partner.tiktokshop.com → API Testing Tool'
      + '\n2. Get shop authorization → Authorize'
      + '\n3. 새 access_token 복사'
      + '\n4. GAS → saveTikTokAccessToken() 함수에 붙여넣기 → Run';
    const body = type === '만료'
      ? 'TikTok Access Token이 만료되었습니다.\n\n지금 바로 갱신하세요:\n' + guide + '\n\n시간: ' + new Date().toLocaleString()
      : 'TikTok Access Token이 ' + remainMin + '분 후 만료됩니다.\n\n미리 갱신해두세요:\n' + guide + '\n\n시간: ' + new Date().toLocaleString();
    MailApp.sendEmail(email, subject, body);
    Logger.log('이메일 발송: ' + email);
  } catch(e) {
    Logger.log('이메일 발송 실패: ' + e.message);
  }
}

/**
 * ★ 토큰 만료 체크 트리거 설정 (30분마다 자동 체크)
 * 최초 1회 실행하면 이후 자동으로 만료 전 이메일 알림
 */
function setupTokenCheckTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkTikTokToken') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('checkTikTokToken')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('✅ 토큰 체크 트리거 등록 완료 (30분마다)');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    '30분마다 토큰 체크 + 만료 30분 전 이메일 알림 설정 완료!', '✅ Done', 5
  );
}

function testTikTokConnection() {
  Logger.log('=== testTikTokConnection (v32) ===');

  // ★ 먼저 토큰 만료 확인
  const tokenOk = checkTikTokToken();
  if (!tokenOk) {
    Logger.log('❌ 토큰 만료로 테스트 중단. saveTikTokAccessToken() 실행 후 재시도');
    return;
  }

  const date = today_();
  Logger.log('Testing TikTok connection for date: ' + date);
  const r = fetchTikTokShippedOrders_(date);
  if (r.ok) {
    Logger.log('✅ TikTok API 연결 성공! 오늘 IN_TRANSIT 주문: ' + r.orders.length + '개');
    if (r.orders.length > 0) {
      Logger.log('첫 번째 주문 ID: ' + (r.orders[0].id || r.orders[0].order_id));
    }
  } else {
    Logger.log('❌ TikTok API 연결 실패: ' + r.error);
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(
    r.ok ? '✅ TikTok 연결 성공! 주문 ' + r.orders.length + '개' : '❌ 실패: ' + r.error,
    'TikTok Test', 5
  );
}

/**
 * ★ CBT 필드 분포 완전 진단 — 필터 없이 AWAITING_SHIPMENT 전체 조회
 * fulfillment_type, delivery_option_name 분포 확인 → 214건 식별 기준 찾기
 */
function testCBTFieldDistribution() {
  const appKey      = PROP.getProperty('TT_APP_KEY')      || '';
  const appSecret   = PROP.getProperty('TT_APP_SECRET')   || '';
  const accessToken = PROP.getProperty('TT_ACCESS_TOKEN') || '';
  const shopCipher  = PROP.getProperty('TT_SHOP_CIPHER')  || '';

  // page_size를 body에 포함 (기존 callTikTokAPI_ 방식과 동일하게)
  const body = {
    order_status: 'AWAITING_SHIPMENT',
    page_size:    50,
    sort_field:   'CREATE_TIME',
    sort_order:   'DESC',
  };
  const r = callTikTokAPI_('/order/202309/orders/search', body);
  if (!r.ok) { Logger.log('❌ 오류: ' + r.error); return; }

  const orders = r.data.orders || [];
  const totalCount = r.data.total_count || 0;
  Logger.log('total_count=' + totalCount + ', 이번 페이지=' + orders.length + '건');

  const distFT  = {};
  const distDON = {};
  const distSP  = {};

  orders.forEach((o, i) => {
    const ft  = String(o.fulfillment_type        || 'null');
    const don = String(o.delivery_option_name    || 'null');
    const sp  = String(o.shipping_provider       || 'null');
    distFT[ft]   = (distFT[ft]   || 0) + 1;
    distDON[don] = (distDON[don] || 0) + 1;
    distSP[sp]   = (distSP[sp]   || 0) + 1;
    if (i < 3) {
      Logger.log('주문' + (i+1) + ': ft=' + ft + ' | don=' + don + ' | sp=' + sp);
    }
  });

  Logger.log('fulfillment_type 분포: ' + JSON.stringify(distFT));
  Logger.log('delivery_option_name 분포: ' + JSON.stringify(distDON));
  Logger.log('shipping_provider 분포: ' + JSON.stringify(distSP));

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Execution log에서 fulfillment_type 분포 확인!', '✅ 진단 완료', 8
  );
}

/**
 * ★ PickLists 중복 행 정리
 * 같은 pgNo+date 조합이 여러 행 있으면 마지막 행만 남기고 나머지 삭제
 * GAS 에디터에서 수동 실행
 */
function deduplicatePickLists() {
  const sh = listsSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('No data'); return; }
  
  const data = sh.getRange(2, 1, lastRow-1, 19).getValues();
  const seen = {}; // pgNo_date → last row index
  
  // 마지막 등장 위치 기록
  data.forEach((row, i) => {
    const pgNo = String(row[1]);
    const rawDate = row[0];
    const date = rawDate instanceof Date
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(rawDate).slice(0,10);
    const status = String(row[13]);
    if (pgNo && status !== 'Deleted') {
      seen[pgNo + '_' + date] = i;
    }
  });
  
  // 중복 행 Deleted 처리
  let count = 0;
  data.forEach((row, i) => {
    const pgNo = String(row[1]);
    const rawDate = row[0];
    const date = rawDate instanceof Date
      ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(rawDate).slice(0,10);
    const status = String(row[13]);
    if (pgNo && status !== 'Deleted') {
      const key = pgNo + '_' + date;
      if (seen[key] !== i) {
        // 마지막 행이 아니면 Deleted 처리
        sh.getRange(2+i, 14).setValue('Deleted');
        sh.getRange(2+i, 14).setBackground('#FFCCCC').setFontColor('#9C0006');
        count++;
        Logger.log('중복 삭제: ' + pgNo + ' (' + date + ') row ' + (2+i));
      }
    }
  });
  
  bumpVersion_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    count + '개 중복 행 정리 완료!', '✅ 중복 정리', 5
  );
  Logger.log('총 ' + count + '개 중복 행 정리');
}

function testWebhookSimulate() {
  // ShipStation이 보내는 형식 그대로 시뮬레이션
  const fakePayload = {
    resource_type: 'SHIP_NOTIFY',
    resource_url: '',
    orderNumber: 'MD-2026-152074'  // 실제 오늘 주문번호로 변경
  };
  
  const result = handleSSWebhook_(fakePayload);
  Logger.log('결과: ' + JSON.stringify(result));
}

function testScanToVerifyAPI() {
  const key    = PROP.getProperty('SS_API_KEY')    || '';
  const secret = PROP.getProperty('SS_API_SECRET') || '';
  const auth   = 'Basic ' + Utilities.base64Encode(key + ':' + secret);
  const today  = today_();

  Logger.log('=== Scan to Verify API 테스트 시작: ' + today + ' ===');

  // ① shipDate 기준 (기존 방식) - 오늘 ship된 것
  const url1 = 'https://ssapi.shipstation.com/shipments'
    + '?shipDateStart=' + today + '%2000%3A00%3A00'
    + '&shipDateEnd='   + today + '%2023%3A59%3A59'
    + '&pageSize=10';

  const r1 = UrlFetchApp.fetch(url1, {
    method: 'GET',
    headers: { 'Authorization': auth },
    muteHttpExceptions: true,
  });
  const d1 = JSON.parse(r1.getContentText());
  Logger.log('① shipDate 기준 오늘: ' + (d1.total || 0) + '건');

  // ② 어제 shipDate + 오늘 voided 아닌 것 (어제 라벨, 오늘 스캔 케이스)
  const yesterday = getYesterday_();
  const url2 = 'https://ssapi.shipstation.com/shipments'
    + '?shipDateStart=' + yesterday + '%2000%3A00%3A00'
    + '&shipDateEnd='   + yesterday + '%2023%3A59%3A59'
    + '&pageSize=10';

  const r2 = UrlFetchApp.fetch(url2, {
    method: 'GET',
    headers: { 'Authorization': auth },
    muteHttpExceptions: true,
  });
  const d2 = JSON.parse(r2.getContentText());
  Logger.log('② shipDate 기준 어제: ' + (d2.total || 0) + '건');

  // 어제 shipment 첫 번째 항목의 모든 필드 확인
  if (d2.shipments && d2.shipments.length > 0) {
    const s = d2.shipments[0];
    Logger.log('--- 어제 shipment 샘플 필드 ---');
    Logger.log('orderNumber: '    + s.orderNumber);
    Logger.log('shipDate: '       + s.shipDate);
    Logger.log('createDate: '     + s.createDate);
    Logger.log('modifyDate: '     + s.modifyDate);    // ★ 수정날짜 = 스캔날짜?
    Logger.log('voided: '         + s.voided);
    Logger.log('trackingNumber: ' + s.trackingNumber);

    // ★ 핵심: modifyDate가 오늘이면 = 오늘 스캔된 것
    const modDate = s.modifyDate ? String(s.modifyDate).slice(0,10) : '';
    Logger.log('modifyDate 날짜 부분: ' + modDate + ' (오늘: ' + today + ')');
    if (modDate === today) {
      Logger.log('✅ modifyDate = 오늘 → 오늘 스캔된 것으로 판별 가능!');
    }
  }

  Logger.log('=== 테스트 1 완료 ===');
}


/* ────────────────────────────────────────
   테스트 2: modifyDate 기준으로 오늘 스캔된 주문 조회
   → Scan to Verify 시점 = modifyDate 인지 확인
──────────────────────────────────────── */
function testModifyDateFilter() {
  const key    = PROP.getProperty('SS_API_KEY')    || '';
  const secret = PROP.getProperty('SS_API_SECRET') || '';
  const auth   = 'Basic ' + Utilities.base64Encode(key + ':' + secret);
  const today  = today_();

  Logger.log('=== modifyDate 기준 테스트: ' + today + ' ===');

  // modifyDate 기준으로 오늘 수정된 shipments 조회
  const url = 'https://ssapi.shipstation.com/shipments'
    + '?modifyDateStart=' + today + '%2000%3A00%3A00'
    + '&modifyDateEnd='   + today + '%2023%3A59%3A59'
    + '&pageSize=100';

  const r = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: { 'Authorization': auth },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(r.getContentText());
  Logger.log('modifyDate 기준 오늘 수정된 shipments: ' + (data.total || 0) + '건');

  if (data.shipments && data.shipments.length > 0) {
    // 채널별 카운트
    const catCount = {};
    data.shipments.forEach(s => {
      if (s.voided) return; // voided 제외
      const detected = detectChannel_(s.orderNumber || '');
      const cat = detected ? detected.cat : 'Unknown';
      catCount[cat] = (catCount[cat] || 0) + 1;
    });

    Logger.log('--- 채널별 카운트 ---');
    Object.entries(catCount).forEach(([cat, cnt]) => {
      Logger.log(cat + ': ' + cnt + '건');
    });

    // 첫 번째 항목 상세
    const s0 = data.shipments[0];
    Logger.log('--- 첫 번째 샘플 ---');
    Logger.log('orderNumber: ' + s0.orderNumber);
    Logger.log('shipDate: '    + s0.shipDate);
    Logger.log('modifyDate: '  + s0.modifyDate);
    Logger.log('voided: '      + s0.voided);
  }

  Logger.log('=== 테스트 2 완료 ===');
}


/* ────────────────────────────────────────
   테스트 3: Orders API - lastModified 기준
   → 오늘 상태가 변경된 주문 조회 (Scan to Verify 시)
──────────────────────────────────────── */
function testOrderModifyDate() {
  const key    = PROP.getProperty('SS_API_KEY')    || '';
  const secret = PROP.getProperty('SS_API_SECRET') || '';
  const auth   = 'Basic ' + Utilities.base64Encode(key + ':' + secret);
  const today  = today_();

  Logger.log('=== Orders modifyDate 기준 테스트: ' + today + ' ===');

  const url = 'https://ssapi.shipstation.com/orders'
    + '?modifyDateStart=' + today + '%2000%3A00%3A00'
    + '&modifyDateEnd='   + today + '%2023%3A59%3A59'
    + '&orderStatus=shipped'
    + '&pageSize=100';

  const r = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: { 'Authorization': auth },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(r.getContentText());
  Logger.log('오늘 수정된 shipped 주문: ' + (data.total || 0) + '건');

  if (data.orders && data.orders.length > 0) {
    const catCount = {};
    data.orders.forEach(o => {
      const detected = detectChannel_(o.orderNumber || '');
      const cat = detected ? detected.cat : 'Unknown';
      catCount[cat] = (catCount[cat] || 0) + 1;
    });

    Logger.log('--- 채널별 카운트 ---');
    Object.entries(catCount).forEach(([cat, cnt]) => {
      Logger.log(cat + ': ' + cnt + '건');
    });

    // 첫 번째 항목
    const o0 = data.orders[0];
    Logger.log('--- 첫 번째 샘플 ---');
    Logger.log('orderNumber: ' + o0.orderNumber);
    Logger.log('orderDate: '   + o0.orderDate);
    Logger.log('modifyDate: '  + o0.modifyDate);
    Logger.log('orderStatus: ' + o0.orderStatus);
  }

  Logger.log('=== 테스트 3 완료 ===');
}


/* ────────────────────────────────────────
   헬퍼: 어제 날짜 반환
──────────────────────────────────────── */
function getYesterday_() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function testFetchVerifiedV40() {
  const key    = PROP.getProperty('SS_API_KEY')    || '';
  const secret = PROP.getProperty('SS_API_SECRET') || '';

  if (!key || !secret) {
    Logger.log('❌ SS API credentials not set');
    return;
  }

  const date = today_();
  Logger.log('=== testFetchVerifiedV40: ' + date + ' ===');

  const result = fetchVerifiedShipments_(key, secret, date);

  if (!result.ok) {
    Logger.log('❌ 실패: ' + result.error);
    return;
  }

  Logger.log('✅ 총 조회: ' + result.shipments.length + '건');

  // 채널별 카운트
  const catCount = {};
  result.shipments.forEach(s => {
    const detected = detectChannel_(String(s.orderNumber));
    const cat = detected ? detected.cat : 'Unknown';
    catCount[cat] = (catCount[cat] || 0) + 1;
  });

  Logger.log('--- 채널별 카운트 ---');
  Object.entries(catCount).forEach(([cat, cnt]) => {
    Logger.log(cat + ': ' + cnt + '건');
  });

  // 이미 스캔 로그에 있는 것 확인
  const logData = getScanLog_(date);
  const alreadyScanned = new Set(
    (logData.entries || []).map(e => String(e.barcode))
  );
  Logger.log('이미 처리된 건수: ' + alreadyScanned.size);

  const newOrders = result.shipments.filter(s =>
    !alreadyScanned.has(String(s.orderNumber))
  );
  Logger.log('신규 처리 필요: ' + newOrders.length + '건');

  // 채널별 신규 카운트
  const newCatCount = {};
  newOrders.forEach(s => {
    const detected = detectChannel_(String(s.orderNumber));
    const cat = detected ? detected.cat : 'Unknown';
    newCatCount[cat] = (newCatCount[cat] || 0) + 1;
  });

  Logger.log('--- 신규 채널별 카운트 ---');
  Object.entries(newCatCount).forEach(([cat, cnt]) => {
    Logger.log(cat + ': ' + cnt + '건 신규');
  });

  Logger.log('=== testFetchVerifiedV40 완료 ===');
  Logger.log('결과가 웹브라우저 픽리스트 Orders 수량과 일치하면 적용 OK!');
}
