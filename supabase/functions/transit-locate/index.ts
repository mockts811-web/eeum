// transit-locate: 실시간 위치로 "탔던 열차·버스 후보"를 추정할 수 있게 돕는 서버 함수 (지하철 열차 + 버스)
// 배포 전: 코드를 GitLab에 먼저 올리세요 (원본 백업 규칙)
// 인증키는 코드에 넣지 말고 Secrets로만 등록하세요:
//   SEOUL_SUBWAY_KEY (서울 열린데이터광장 지하철 인증키), SEOUL_BUS_KEY (버스 인증키)

const CORS = {
  'Access-Control-Allow-Origin': '*', // 배포 사이트와 zip으로 연 index.html 모두 호출하도록 열어 둠 (공개 데이터만 반환)
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 지하철: 서울 열린데이터광장 실시간 열차 위치 (실제 응답 필드는 배포 전 확인 필요)
const SUBWAY_BASE = 'http://swopenAPI.seoul.go.kr/api/subway'; // 사용자 승인으로 http 사용 (https 호출이 Supabase에서 시간 초과)
// 버스: 서울시 버스 정보 API (주소·응답 필드는 활용가이드로 확인 필요)
const BUS_BASE = 'http://ws.bus.go.kr/api/rest';
const CACHE_MS = 20_000; // 같은 요청은 20초 동안 재사용해 인증키 호출 횟수를 아낌

const cache = new Map<string, { at: number; body: unknown }>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 키가 없거나 호출이 실패해도 화면이 멈추지 않도록, 프론트가 시연 계산으로 돌아가게 하는 응답
function demo(note: string) {
  return { source: 'demo', note };
}

// 공공 API는 항목이 1개일 때 객체로, 여러 개일 때 배열로 줄 때가 있어 배열로 맞춤
function toArr(v: unknown): any[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// 서울 API가 응답하지 않을 때 화면이 무한 대기하지 않도록 20초 제한
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  return await res.json();
}

// ---------- 지하철 (서울 지하철 노선별 실시간 열차 위치) ----------
// 서울 지하철 노선 목록: 1~9호선 + 경전철·전철. 노선 하나가 실패해도 나머지는 계속 조회함
const SUBWAY_LINES = [
  '1호선', '2호선', '3호선', '4호선', '5호선', '6호선', '7호선', '8호선', '9호선',
  '경의중앙선', '수인분당선', '신분당선', '우이신설선', '신림선',
];

// 응답 updnLine은 "0"/"1" 입니다. 내선=0, 외선=1로 대응 (실제 열차 방향과 맞는지 배포 후 확인 필요)
async function subwayLine(key: string, line: string, code: string) {
  const data = await getJson(`${SUBWAY_BASE}/${key}/json/realtimePosition/0/100/${encodeURIComponent(line)}`);
  const errCode = data?.errorMessage?.code;
  // INFO-000: 정상, INFO-200: 해당 노선에 운행 중인 열차 없음 → 오류 아님
  if (errCode && errCode !== 'INFO-000' && errCode !== 'INFO-200') {
    return { trains: [], err: JSON.stringify(data.errorMessage).slice(0, 300) };
  }
  const trains = toArr(data?.realtimePositionList)
    .filter((t: any) => String(t.updnLine) === code)
    .map((t: any) => ({
      line: t.subwayNm ?? line,
      trainNo: t.trainNo,
      station: t.statnNm,
      status: ['진입', '도착', '출발'][Number(t.trainSttus)] ?? '',
      updn: t.updnLine,
    }));
  return { trains, err: undefined as string | undefined };
}

async function subwayLive(key: string, dir: string, stations: string[]) {
  const code = dir === '내선' ? '0' : '1';
  const results = await Promise.all(
    SUBWAY_LINES.map((l) => subwayLine(key, l, code).catch((e) => ({ trains: [], err: String((e as Error)?.message ?? e) }))),
  );
  // 모든 노선이 오류면 인증키 등 문제이므로 시연 계산으로 돌아감
  if (results.every((r) => r.err)) return demo('서울 응답: ' + (results[0].err ?? '알 수 없는 오류'));
  const trains = results
    .flatMap((r) => r.trains)
    .map((t: any) => ({ ...t, idx: stations.indexOf(t.station) })); // 프론트가 보낸 노선 역 순서에서의 위치 (없으면 -1)
  return { source: 'live', trains };
}

// ---------- 버스 (노선 번호 → 노선 ID → 정류소 순서·버스 위치) ----------
async function busLive(key: string, route: string, withPositions = true) {
  const q = `ServiceKey=${encodeURIComponent(key)}&resultType=json`;

  // 1) 노선 번호로 노선 ID 찾기
  const routeData = await getJson(`${BUS_BASE}/busRouteInfo/getBusRouteList?${q}&strSrch=${encodeURIComponent(route)}`);
  const hit = toArr(routeData?.msgBody?.itemList).find((r: any) => String(r.busRouteNm) === route);
  if (!hit) return demo('노선 번호를 찾지 못해 시연 계산을 써요.');
  const routeId = String(hit.busRouteId);

  // 2) 노선의 정류소 순서
  const stData = await getJson(`${BUS_BASE}/busRouteInfo/getStaionByRoute?${q}&busRouteId=${routeId}`);
  const stops = toArr(stData?.msgBody?.itemList)
    .map((s: any, i: number) => ({ nm: String(s.stationNm), seq: Number(s.seq ?? i + 1), dist: Number(s.fullSectDist ?? 0), spd: Number(s.sectSpd ?? 0) })) // #서유석 수정 (6차): 정류장 사이 거리(m)·구간 속도(km/h) → 화면에서 탔던 버스 위치 계산
    .sort((a, b) => a.seq - b.seq);
  if (stops.length === 0) return demo('정류소 정보를 받지 못해 시연 계산을 써요.');

  if (!withPositions) return { source: 'live', routeId, stops, buses: [] };

  // 3) 지금 노선을 달리는 버스의 위치
  const posData = await getJson(`${BUS_BASE}/buspos/getBusPosByRtid?${q}&busRouteId=${routeId}`);
  const buses = toArr(posData?.msgBody?.itemList).map((p: any) => {
    const seq = Number(p.stationSeq ?? p.sectOrd); // 필드명은 활용가이드로 확인 필요
    return { plainNo: String(p.plainNo ?? ''), idx: stops.findIndex((s) => s.seq === seq) };
  });

  return { source: 'live', routeId, stops, buses };
}

// ---------- 경기도·인천 버스 (노선 ID로 직접 조회) ----------
// 경기: 노선 ID(routeId)로 차량 위치 목록 (JSON). 차량번호(plateNo), 정류소 순번(stationSeq), 상태(stateCd: 1=정류소 도착)
async function gyeonggiBuses(key: string, routeId: string) {
  const url = `https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2?format=json&serviceKey=${encodeURIComponent(key)}&routeId=${encodeURIComponent(routeId)}`;
  const d = await getJson(url);
  return toArr(d?.response?.msgBody?.busLocationList).map((b: any) => ({
    plainNo: String(b.plateNo ?? ''),
    seq: Number(b.stationSeq ?? -1),
    arrived: Number(b.stateCd) === 1,
  }));
}

// 인천: 노선 ID(routeId)로 차량 위치 목록 (XML). 차량번호(BUS_NUM_PLATE), 최근 정류소순번(LATEST_STOPSEQ)
async function incheonBuses(key: string, routeId: string) {
  const url = `https://apis.data.go.kr/6280000/busLocationService/getBusRouteLocation?ServiceKey=${encodeURIComponent(key)}&pageNo=1&numOfRows=100&routeId=${encodeURIComponent(routeId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const xml = await res.text();
  const items = xml.split('<itemList>').slice(1).map((chunk) => {
    const g = (tag: string) => (chunk.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '');
    return { plainNo: g('BUS_NUM_PLATE'), seq: Number(g('LATEST_STOPSEQ') || -1), arrived: false }; // 인천 응답의 도착 여부 필드는 없어서 false
  });
  return items;
}

// 인천: 노선번호로 노선 목록 검색 (국토부 인천광역시_버스노선 조회, http 주소 사용 — 가이드 기준)
const INCHEON_ROUTE_BASE = 'http://apis.data.go.kr/6280000/busRouteService';
async function incheonRoutes(key: string, routeNo: string) {
  const xml = await (await fetch(`${INCHEON_ROUTE_BASE}/getBusRouteNo?routeNo=${encodeURIComponent(routeNo)}&numOfRows=100&pageNo=1&serviceKey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) })).text();
  if (!xml.includes('<itemList>')) throw new Error('인천 응답: ' + xml.replace(/\s+/g, ' ').slice(0, 200));
  return xml.split('<itemList>').slice(1).map((chunk) => {
    const g = (tag: string) => (chunk.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '');
    return { routeId: g('ROUTEID'), routeNo: g('ROUTENO'), origin: g('ORIGIN_BSTOPNM'), dest: g('DEST_BSTOPNM') };
  }).filter((r) => r.routeNo === routeNo || r.routeNo.startsWith(routeNo + '-')); // 564 검색 시 564-1 등 변형 노선 포함, 다른 번호는 제외
}

// 인천: 노선ID로 경유 정류소 목록 (방향 DIRCD 0 상행, 1 하행)
async function incheonStops(key: string, routeId: string) {
  const xml = await (await fetch(`${INCHEON_ROUTE_BASE}/getBusRouteSectionList?routeId=${encodeURIComponent(routeId)}&numOfRows=200&pageNo=1&serviceKey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) })).text();
  if (!xml.includes('<itemList>')) throw new Error('인천 응답: ' + xml.replace(/\s+/g, ' ').slice(0, 200));
  return xml.split('<itemList>').slice(1).map((chunk) => {
    const g = (tag: string) => (chunk.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '');
    return { nm: g('BSTOPNM'), seq: Number(g('BSTOPSEQ') || -1), dir: g('DIRCD') };
  });
}

// 경기: 노선번호(키워드)로 노선 목록 검색 (경기도_버스노선 조회, JSON). 번호가 정확히 같은 노선만 반환
async function gyeonggiRoutes(key: string, keyword: string) {
  const url = `https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteListv2?format=json&serviceKey=${encodeURIComponent(key)}&keyword=${encodeURIComponent(keyword)}`;
  const d = await getJson(url);
  return toArr(d?.response?.msgBody?.busRouteList)
    .filter((r: any) => String(r.routeName) === keyword)
    .map((r: any) => ({ routeId: String(r.routeId), routeNo: String(r.routeName), type: String(r.routeTypeName ?? ''), origin: String(r.startStationName ?? ''), dest: String(r.endStationName ?? ''), region: String(r.adminName ?? '') }));
}

// 경기: 노선ID로 경유 정류소 목록 (경기도_버스노선 조회 · 경유정류소목록조회, JSON). 정류소 순번 stationSeq 기준
async function gyeonggiStops(key: string, routeId: string) {
  const url = 'https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteStationListv2?format=json&serviceKey=' + encodeURIComponent(key) + '&routeId=' + encodeURIComponent(routeId);
  const d = await getJson(url);
  return toArr(d?.response?.msgBody?.busRouteStationList)
    .map((s: any) => ({ nm: String(s.stationName ?? ''), seq: Number(s.stationSeq ?? -1) }))
    .sort((a, b) => a.seq - b.seq);
}

// 서울 지하철 노선별 역 순서 (서울열린데이터 SearchSTNBySubwayLineInfo). 역코드(FR_CODE) 기준 정렬
async function subwayStations(key: string) {
  const base = 'http://openapi.seoul.go.kr:8088/' + encodeURIComponent(key) + '/json/SearchSTNBySubwayLineInfo/';
  const pages = await Promise.all([base + '1/1000/', base + '1001/2000/'].map((u) => getJson(u).catch(() => null)));
  const rows = pages.flatMap((d: any) => toArr(d?.SearchSTNBySubwayLineInfo?.row));
  const by: Record<string, { nm: string; code: string }[]> = {};
  rows.forEach((r: any) => { const l = String(r.LINE_NUM ?? ''); (by[l] = by[l] || []).push({ nm: String(r.STATION_NM ?? ''), code: String(r.FR_CODE ?? '') }); });
  const lines: Record<string, string[]> = {};
  Object.keys(by).forEach((l) => { lines[l] = by[l].sort((a, b) => a.code.localeCompare(b.code)).map((x) => x.nm).filter((n, i, arr) => arr.indexOf(n) === i); });
  return lines;
}

// 서울 버스 노선 목록 (노선번호 앞글자로 검색해 모음). 번호는 숫자·영문 접두어 기준
async function seoulRouteList(key: string) {
  const q = 'ServiceKey=' + encodeURIComponent(key) + '&resultType=json';
  const prefixes = ['0','1','2','3','4','5','6','7','8','9','N','M','G','P','B','D','X','C','Y','S'];
  const pages = await Promise.all(prefixes.map((p) => getJson(BUS_BASE + '/busRouteInfo/getBusRouteList?' + q + '&strSrch=' + p).catch(() => null)));
  const seen: Record<string, { nm: string; id: string; type: string }> = {};
  pages.forEach((d: any) => toArr(d?.msgBody?.itemList).forEach((r: any) => {
    const nm = String(r.busRouteNm ?? '');
    if (nm && !seen[nm]) seen[nm] = { nm, id: String(r.busRouteId ?? ''), type: String(r.routeType ?? '') };
  }));
  return Object.values(seen).sort((a, b) => a.nm.localeCompare(b.nm, 'ko', { numeric: true }));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST 요청만 받아요.' }, 405);

  let input: { mode?: string; station?: string; dir?: string; stations?: string[]; bus?: string; stop?: string };
  try {
    input = await req.json();
  } catch {
    return json({ error: '요청 형식이 올바르지 않아요.' }, 400);
  }

  const cacheKey = JSON.stringify(
    input.mode === '버스' || input.mode === '노선' || input.mode === '인천노선' || input.mode === '경기노선' ? [input.mode, input.bus]
    : input.mode === '경기정류소' ? [input.mode, (input as any).routeId]
    : input.mode === '인천정류소' ? [input.mode, (input as any).routeId]
    : input.mode === '경기버스' || input.mode === '인천버스' ? [input.mode, (input as any).routeId]
    : ['지하철', input.dir],
  );
  const hitCache = cache.get(cacheKey);
  if (hitCache && Date.now() - hitCache.at < CACHE_MS) return json(hitCache.body);

  let body: unknown;
  try {
    if (input.mode === '서울노선') {
      const key = Deno.env.get('SEOUL_BUS_KEY');
      if (!key) body = demo('버스 인증키가 설정되지 않아요.');
      else body = { source: 'live', routes: await seoulRouteList(key) };
    } else if (input.mode === '지하철역') {
      const key = Deno.env.get('SEOUL_SUBWAY_KEY');
      if (!key) body = demo('지하철 인증키가 설정되지 않아요.');
      else body = { source: 'live', lines: await subwayStations(key) };
    } else if (input.mode === '경기정류소') {
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const routeId = String((input as any).routeId ?? '').replace(/[^0-9]/g, '');
      if (!key) body = demo('버스 인증키가 설정되지 않아요.');
      else if (!routeId) body = demo('노선 ID가 없어요.');
      else body = { source: 'live', region: '경기', routeId, stops: await gyeonggiStops(key, routeId) };
    } else if (input.mode === '경기노선') {
      // 경기 노선번호 검색 → 노선 후보 목록 (노선ID를 얻어 경기버스 위치 조회에 사용)
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const kw = String((input as any).bus ?? '').trim();
      if (!key) body = demo('버스 인증키가 설정되지 않아요.');
      else if (!kw) body = demo('노선 번호가 없어요.');
      else body = { source: 'live', region: '경기', routes: await gyeonggiRoutes(key, kw) };
    } else if (input.mode === '인천노선') {
      // 인천 노선번호 검색 → 노선 후보 목록 (화면에서 방향을 고르게 함)
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const routeNo = String((input as any).bus ?? '').trim();
      if (!key) body = demo('버스 인증키가 설정되지 않아요.');
      else if (!routeNo) body = demo('노선 번호가 없어요.');
      else body = { source: 'live', region: '인천', routes: await incheonRoutes(key, routeNo) };
    } else if (input.mode === '인천정류소') {
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const routeId = String((input as any).routeId ?? '').replace(/[^0-9]/g, '');
      if (!key) body = demo('버스 인증키가 설정되지 않아요.');
      else if (!routeId) body = demo('노선 ID가 없어요.');
      else body = { source: 'live', region: '인천', routeId, stops: await incheonStops(key, routeId) };
    } else if (input.mode === '경기버스' || input.mode === '인천버스') {
      // 경기·인천: 노선 ID(routeId)를 직접 받아 차량 위치 목록 반환 (같은 인증키 사용)
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const routeId = String((input as any).routeId ?? '').replace(/[^0-9]/g, '');
      if (!key) body = demo('버스 인증키가 설정되지 않아요.');
      else if (!routeId) body = demo('노선 ID가 없어요.');
      else {
        const buses = input.mode === '경기버스' ? await gyeonggiBuses(key, routeId) : await incheonBuses(key, routeId);
        body = { source: 'live', region: input.mode, routeId, buses };
      }
    } else if (input.mode === '노선') {
      // 노선 번호로 정류소 목록만 가져오기 (화면의 내린 정류장 선택용)
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const route = String(input.bus ?? '').replace(/[^0-9]/g, '');
      body = !key ? demo('버스 인증키가 설정되지 않아요.') : !route ? demo('노선 번호가 없어요.') : await busLive(key, route, false);
    } else if (input.mode === '버스') {
      const key = Deno.env.get('SEOUL_BUS_KEY');
      const route = String(input.bus ?? '').replace(/[^0-9]/g, '');
      if (!key) body = demo('버스 인증키가 설정되지 않아 시연 계산을 써요.');
      else if (!route) body = demo('노선 번호가 없어 시연 계산을 써요.');
      else body = await busLive(key, route);
    } else {
      const key = Deno.env.get('SEOUL_SUBWAY_KEY');
      if (!key) body = demo('열차 인증키가 설정되지 않아 시연 계산을 써요.');
      else body = await subwayLive(key, input.dir === '내선' ? '내선' : '외선', Array.isArray(input.stations) ? input.stations : []);
    }
  } catch (_e) {
    body = demo('실시간 정보 연결에 실패해 시연 계산을 써요. (' + String((_e as Error)?.message ?? _e) + ')');
  }

  cache.set(cacheKey, { at: Date.now(), body });
  return json(body);
});
