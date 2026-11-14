// 고현 수정 시작: 실제 PostgreSQL 로직과 격리된 HTTP를 사용하는 사진 자동화 검증
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const ts = require('typescript');
const contract = require('../supabase/functions/_shared/photo-analysis.ts');
const { createPhotoWorker } = require('../supabase/functions/auto-analyze-items/handler.ts');
const root = path.resolve(__dirname, '..');
const base = 'https://xhvthvxpwlaecizqlrrv.supabase.co';
const serviceKey = 'LOCAL_SERVICE_KEY_123456789012345';
const secret = 'LOCAL_PHOTO_SECRET_12345678901234567890';
const owner = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';
const passed = [];
let db;
async function check(name, run) { await run(); passed.push(name); console.log('PASS', name); }
async function fixture() {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,
      metadata jsonb,version text,updated_at timestamptz DEFAULT now(),UNIQUE(bucket_id,name));
    CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
  `);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/1_schema.sql'), 'utf8'));
  // 사용자가 제공한 운영 조회에서 확인된 기존 DELETE 정책과 넓은 ACL을 재현합니다.
  await db.exec(`
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='items' AND policyname='담당자 삭제') THEN
      CREATE POLICY "담당자 삭제" ON public.items FOR DELETE TO authenticated USING
        (EXISTS(SELECT 1 FROM public.staff_members s WHERE s.user_id=auth.uid() AND s.org_id=items.org_id));
    END IF; END $$;
    GRANT DELETE ON public.items TO authenticated;
    GRANT MAINTAIN,REFERENCES,TRIGGER,TRUNCATE ON public.items,public.orgs,public.staff_members TO anon,authenticated;
    GRANT MAINTAIN,REFERENCES,TRIGGER ON public.item_private TO anon,authenticated;
    INSERT INTO public.orgs(name,kind) VALUES('LOCAL ORG A','경찰서'),('LOCAL ORG B','경찰서');
    INSERT INTO auth.users(id) VALUES('${owner}'),('${outsider}');
    INSERT INTO public.staff_members(user_id,org_id) VALUES('${owner}',1),('${outsider}',2);
  `);
}
async function asRole(role, uid, run) {
  await db.exec(`SET ROLE ${role}`);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid || '']);
  try { return await run(); } finally { await db.exec('RESET ROLE'); }
}
async function publicSnapshot() {
  return (await db.query(`SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema='public' AND table_name IN ('items','item_private','staff_members','orgs')),
    'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
    'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY table_name,grantee,privilege_type) FROM information_schema.role_table_grants g WHERE table_schema='public' AND table_name IN ('items','item_private','staff_members','orgs'))
  ) AS value`)).rows[0].value;
}
async function add(id, options = {}) {
  const photo = options.photo === undefined ? `api/${id}.jpg` : options.photo;
  if (photo && !options.noObject) await db.query(`INSERT INTO storage.objects(bucket_id,name,metadata,version) VALUES('item-photos',$1,$2::jsonb,'v1') ON CONFLICT(bucket_id,name) DO NOTHING`,
    [photo.startsWith(base) ? photo.split('/item-photos/')[1] : photo, JSON.stringify({ size: options.bytes || 128, mimetype: options.mime || 'image/jpeg', ...(options.etag?{eTag:'"'+options.etag+'"'}:{}) })]);
  await db.query(`INSERT INTO public.items(id,kind,name,category,found_on,org_id,photo_path,created_by,description,color,status)
    VALUES($1,'경찰서','LOCAL ITEM','가방','2026-11-14',$2,$3,$4,$6,'검정',$5)`,
    [id, options.org || 1, photo, options.createdBy || null, options.status || '보관중',options.description===undefined?'ORIGINAL DESCRIPTION':options.description]);
  await db.query(`INSERT INTO public.item_private(item_id,owner_check_memo) VALUES($1,'KEEP ORIGINAL MEMO')`, [id]);
  return id;
}
async function control(mode, id = null, daily = 20) {
  return (await db.query('SELECT public.eeum_photo_ai_configure($1,$2,$3) AS value', [mode, id, daily])).rows[0].value;
}
async function advance(id) {
  await db.exec("UPDATE eeum_photo_ai.control SET next_start_at=now()-interval '1 minute'");
  if (id) await db.query("UPDATE eeum_photo_ai.jobs SET next_try_at=now()-interval '1 minute' WHERE item_id=$1 AND state='retry'", [id]);
}
async function job(id) { return (await db.query('SELECT * FROM eeum_photo_ai.jobs WHERE item_id=$1', [id])).rows[0]; }
async function claim(id = null) {
  return asRole('service_role', null, async () => (await db.query('SELECT public.eeum_photo_ai_claim($1) AS value', [id])).rows[0].value);
}
function analysis(j, extra = {}) {
  return { parser_version: contract.PHOTO_PARSER_VERSION, color: '빨강', materials: ['플라스틱'], shapes: ['퀼팅'], photo_features:['퀼팅'], privacy: false,
    ...extra };
}
async function finish(j, action = 'succeeded', result = analysis(j), reason = null) {
  return asRole('service_role', null, async () => (await db.query(`SELECT public.eeum_photo_ai_finish($1,$2,$3,$4,$5::jsonb,$6) AS value`,
    [j.item_id, j.lease_id, j.source_version, action, result === null ? null : JSON.stringify(result), reason])).rows[0].value);
}
function aiHarness(options = {}) {
  let handler, imageReads = 0, geminiCalls = 0;
  const bytes = new Uint8Array(128); bytes.set([0xff, 0xd8, 0xff]);
  const env = { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: serviceKey, GEMINI_API_KEY: 'LOCAL_ONLY_KEY',
    GEMINI_MODEL: 'gemini-local-test', IMAGE_URL_HOSTS: new URL(base).hostname, AI_TIMEOUT_MS: '2000' };
  const sandbox = { URL, Request, Response, Headers, Uint8Array, AbortController, setTimeout, clearTimeout,
    btoa, crypto: webcrypto, console: { warn() {}, info() {}, error() {} }, photoContract: contract,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    fetch: async (url, init) => {
      if (url.startsWith(base + '/storage/')) { imageReads++; return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }); }
      assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
      geminiCalls++;
      if (options.rejectFirst && geminiCalls === 1) return new Response('{}', { status: 400 });
      if (options.failStatus) return new Response('{}', { status: options.failStatus });
      const request = JSON.parse(init.body);
      assert.equal(init.headers['x-goog-api-key'], 'LOCAL_ONLY_KEY');
      assert.ok(request.contents[0].parts[0].inline_data);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cat: '가방', color: '빨강',
        photoFeats: ['플라스틱','퀼팅'], photoMaterials: ['플라스틱', '가죽 아님'], photoShapes: ['퀼팅'], privacy: false }) }] } }] });
    },
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'supabase/functions/ai-parse/index.ts'), 'utf8')
    .replace(/^import \{[^\n]+\} from "\.\.\/_shared\/photo-analysis\.ts";/m,
      'const {makePhotoAnalysis, PHOTO_PARSER_VERSION, photoPrompt, validatePhotoAnalysis} = photoContract;');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { invoke: body => handler(new Request(base + '/functions/v1/ai-parse', { method: 'POST',
    headers: { authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })),
    calls: () => ({ imageReads, geminiCalls }) };
}
function rpcAdapter() {
  return { rpc: async (name, parameters = {}) => {
    try {
      return await asRole('service_role', null, async () => {
        let result;
        if (name === 'eeum_photo_ai_status') result = await db.query('SELECT public.eeum_photo_ai_status() AS value');
        else if (name === 'eeum_photo_ai_claim') result = await db.query('SELECT public.eeum_photo_ai_claim($1) AS value', [parameters.p_item_id]);
        else if (name === 'eeum_photo_ai_finish') result = await db.query('SELECT public.eeum_photo_ai_finish($1,$2,$3,$4,$5::jsonb,$6) AS value',
          [parameters.p_item_id, parameters.p_lease_id, parameters.p_source_version, parameters.p_action, parameters.p_result === null ? null : JSON.stringify(parameters.p_result), parameters.p_reason]);
        else throw new Error('unexpected RPC');
        return { data: result.rows[0].value, error: null };
      });
    } catch (error) { return { data: null, error: { code: error.code } }; }
  } };
}
const request = body => new Request(base + '/functions/v1/auto-analyze-items', { method: 'POST',
  headers: { 'x-photo-ai-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function main() {
  await fixture();
  await add('POL-HISTORICAL-1');
  const before = await publicSnapshot();
  await check('운영 조회와 핵심 컬럼 대조', async () => {
    if (!process.env.EEUM_SCHEMA_SNAPSHOT) return;
    const rows = JSON.parse(fs.readFileSync(process.env.EEUM_SCHEMA_SNAPSHOT, 'utf8'));
    const actual = (await db.query(`SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname IN ('items','item_private','staff_members','orgs') AND a.attnum>0 AND NOT a.attisdropped`)).rows;
    for (const row of rows.filter(r => r.section === 'column')) assert.ok(actual.some(a => a.table_name === row.table_name && a.name === row.detail.name && a.type === row.detail.type && a.not_null === row.detail.not_null));
  });
  await check('마이그레이션 실행 및 기존 컬럼·RLS·GRANT 보존', async () => {
    await db.exec(fs.readFileSync(path.join(root, 'supabase/photo-ai/01_install.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'supabase/photo-ai/06_upgrade_incoming_ui.sql'), 'utf8'));
    await add('POL-ETAGLEGACY-1',{etag:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'});
    await control('pilot','POL-ETAGLEGACY-1');
    await finish((await claim('POL-ETAGLEGACY-1')).job);await control('off');
    const legacy=await job('POL-ETAGLEGACY-1');
    await db.exec(fs.readFileSync(path.join(root, 'supabase/photo-ai/08_public_features.sql'), 'utf8'));
    assert.equal((await job(legacy.item_id)).attempts,1);
    assert.equal((await job(legacy.item_id)).state,'review');
    assert.notEqual((await job(legacy.item_id)).source_version,legacy.source_version);
    assert.equal((await job(legacy.item_id)).result_source_version,(await job(legacy.item_id)).source_version);
    await db.exec('UPDATE eeum_photo_ai.control SET publish_public=true');
    await add('POL-FORMATOLD-1',{description:'카드지갑(검정색)을 습득하여 보관하고 있습니다.'});
    await control('pilot','POL-FORMATOLD-1');await advance();
    const old=(await claim('POL-FORMATOLD-1')).job;
    await finish(old,'succeeded',analysis(old,{color:null,materials:[],shapes:[],photo_features:['덮개형']}));
    await control('off');await db.exec('UPDATE eeum_photo_ai.control SET publish_public=false');
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/09_tidy_public_descriptions.sql'),'utf8'));
    assert.deepEqual(await publicSnapshot(), before);
    assert.equal((await db.query('SELECT mode FROM eeum_photo_ai.control')).rows[0].mode, 'off');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.items'::regclass AND NOT tgisinternal")).rows[0].n, 2);
  });
  await check('정확한 태그: 부정 표현·개인정보·다른 물품 URL 거부', async () => {
    assert.deepEqual(contract.exactTags(['불투명','가죽 아님','홍길동','무광 아님'], contract.PHOTO_SHAPES,4), ['불투명']);
    assert.equal(contract.storagePhotoURL(base,'POL-TEST-1',base+'/storage/v1/object/public/item-photos/api/OTHER.jpg'), null);
    assert.equal(contract.storagePhotoURL(base,'POL-TEST-1','api/OTHER.jpg'), null);
    assert.equal(contract.classifyPhotoFailure(502,'gemini_http_401').action,'paused');
    assert.equal(contract.classifyPhotoFailure(502,'image_http_408').action,'retry');
  });
  await check('공개 문장 정리는 상투 문구만 제거하고 괄호·모델명·금액·유의미한 메모 보존', async () => {
    for(const [raw,want] of [
      ['프라다 지갑(블랙(검정)색)을 습득하여 보관하고 있습니다.','프라다 지갑(블랙(검정)색)'],
      ['프라다 지갑(블랙(검정)색)을 습득하여 보관하고 있습니다. 사피아노 패턴, 덮개형, 금속 로고','프라다 지갑(블랙(검정)색), 사피아노 패턴, 덮개형, 금속 로고'],
      ['A.P.C. 지갑(검정색)을 습득하여 보관중입니다.','A.P.C. 지갑(검정색)'],
      ['휴대폰(갤럭시 S23)을 습득 후 보관중','휴대폰(갤럭시 S23)'],
      ['1,000원 보관함이 있는 지갑, A.P.C.','1,000원 보관함이 있는 지갑, A.P.C.'],
      ['지갑을 습득하여 보관중이며 연락 바랍니다.','지갑을 습득하여 보관중이며 연락 바랍니다.'],
      [null,null],['','']]) {
      const value=(await db.query('SELECT eeum_photo_ai.tidy_description($1) AS v',[raw])).rows[0].v;
      assert.equal(value,want);assert.equal((await db.query('SELECT eeum_photo_ai.tidy_description($1) AS v',[value])).rows[0].v,value);
    }
  });
  await check('기존 AI 특징 제안 비공개 보존 및 개인정보 패턴 제외', async () => {
    const value=contract.normalizeLegacyPhotoResult({color:'검정',privacy:false,photoFeats:['구부러진 손잡이','검은색 천','성명 김테스트','전화 01012345678']});
    assert.deepEqual(value.photo_features,['구부러진 손잡이','검은색 천']);
    assert.deepEqual(contract.privatePhotoFeatures(['구부러진 손잡이'],true),[]);
  });
  await check('기본 이미지·사진 없음·크기·형식·ID 불일치 제외', async () => {
    for (const [id,opts] of [['POL-NOPHOTO-1',{photo:null}],['POL-DEFAULT-1',{photo:base+'/storage/v1/object/public/item-photos/no_image.jpeg'}],
      ['POL-LARGE-1',{bytes:8_000_001}],['POL-GIF-1',{mime:'image/gif'}],['POL-WRONG-1',{photo:base+'/storage/v1/object/public/item-photos/api/OTHER.jpg'}]]) {
      await add(id,opts); assert.equal(await job(id),undefined);
    }
  });
  await check('정확한 1건 파일럿 및 비활성 기본값', async () => {
    await add('POL-PILOT-1'); await add('POL-PILOT-2');
    assert.equal((await claim('POL-PILOT-1')).reason,'disabled_or_paused');
    await control('pilot','POL-PILOT-1');
    await advance();
    assert.equal((await claim()).reason,'pilot_target_required');
    assert.equal((await claim('POL-PILOT-2')).reason,'pilot_target_required');
    await assert.rejects(()=>control('all'),/successful_pilot_required/);
    await assert.rejects(()=>control('new'),/successful_pilot_required/);
    const j=(await claim('POL-PILOT-1')).job; assert.equal(j.item_id,'POL-PILOT-1');
    assert.equal((await finish(j)).state,'review');
  });
  await check('신규 전용 모드는 등록 전의 기존 사진을 백필하거나 분석하지 않음', async () => {
    await control('new'); await advance();
    assert.equal(await job('POL-HISTORICAL-1'),undefined);
    assert.equal((await claim('POL-HISTORICAL-1')).reason,'no_due_jobs');
    assert.equal(await job('POL-HISTORICAL-1'),undefined);
    await add('POR-INCOMING-1');
    const j=(await claim('POR-INCOMING-1')).job;
    assert.equal(j.item_id,'POR-INCOMING-1'); await finish(j);
    await advance(); assert.equal((await claim('POR-INCOMING-1')).reason,'no_due_jobs');
    assert.equal((await job('POR-INCOMING-1')).attempts,1);
  });
  await check('비공개 결과 조회는 같은 기관 담당자만 가능', async () => {
    const read=()=>db.query("SELECT public.eeum_photo_ai_get('POL-PILOT-1') AS value");
    assert.equal((await asRole('authenticated',owner,read)).rows[0].value.available,true);
    for(const [role,uid] of [['anon',null],['authenticated',outsider],['authenticated','33333333-3333-4333-8333-333333333333']]) {
      await assert.rejects(()=>asRole(role,uid,read),e=>e.code==='42501');
    }
    assert.equal((await asRole('authenticated',owner,()=>db.query("SELECT public.eeum_photo_ai_get('POL-HISTORICAL-1') AS value"))).rows[0].value,null);
  });
  await check('전역 동시 1건 및 완료 후 분당 제한', async () => {
    await add('POL-CAP-1'); await add('POL-CAP-2'); await control('all'); await advance();
    const j=(await claim('POL-CAP-1')).job;
    assert.equal((await claim('POL-CAP-2')).reason,'busy');
    await finish(j);
    assert.equal((await claim('POL-CAP-2')).reason,'minute_limit');
    await advance(); await finish((await claim('POL-CAP-2')).job);
  });
  await check('정상 저장·중복 완료 거부·원본과 비공개 메모 보존', async () => {
    const itemBefore=(await db.query("SELECT to_jsonb(i) AS value FROM public.items i WHERE id='POL-CAP-1'")).rows[0].value;
    assert.equal(itemBefore.color,'검정'); assert.equal(itemBefore.description,'ORIGINAL DESCRIPTION');
    const stored=await job('POL-CAP-1'); assert.equal(stored.result.color,'빨강'); assert.equal(stored.state,'review');
    assert.equal((await db.query("SELECT owner_check_memo FROM public.item_private WHERE item_id='POL-CAP-1'")).rows[0].owner_check_memo,'KEEP ORIGINAL MEMO');
    assert.equal((await finish({item_id:stored.item_id,lease_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source_version:stored.source_version},'failed',null,'timeout')).committed,false);
    assert.deepEqual((await db.query("SELECT to_jsonb(i) AS value FROM public.items i WHERE id='POL-CAP-1'")).rows[0].value,itemBefore);
  });
  await check('시민·담당자의 비공개 큐 직접 접근 차단', async () => {
    for (const role of ['anon','authenticated']) await asRole(role,owner,async()=>{
      await assert.rejects(()=>db.query('SELECT * FROM eeum_photo_ai.jobs'),e=>e.code==='42501');
      await assert.rejects(()=>db.query("SELECT public.eeum_photo_ai_configure('all')"),e=>e.code==='42501');
    });
  });
  await check('같은 Storage 경로 덮어쓰기 탐지', async () => {
    const old=await job('POL-CAP-1');
    await db.query("UPDATE storage.objects SET version='v2',updated_at=now() WHERE name='api/POL-CAP-1.jpg'");
    const stale=(await asRole('authenticated',owner,()=>db.query("SELECT public.eeum_photo_ai_get('POL-CAP-1') AS value"))).rows[0].value;
    assert.equal(stale.available,false); assert.equal(stale.result,undefined);
    await db.query('SELECT public.eeum_photo_ai_backfill(NULL,1000)');
    const current=await job('POL-CAP-1');
    assert.equal(current.state,'pending'); assert.notEqual(current.source_version,old.source_version);
    assert.deepEqual(current.result,old.result);
  });
  await check('5분·15분 재시도 후 3회 실패 상한 및 백필 보존', async () => {
    await add('POL-RETRY-1'); await control('pilot','POL-RETRY-1');
    for(let n=1;n<=3;n++){
      await advance('POL-RETRY-1'); const j=(await claim('POL-RETRY-1')).job;
      await finish(j,'retry',null,'timeout'); const row=await job(j.item_id);
      assert.equal(row.attempts,n);assert.equal(row.state,n<3?'retry':'failed');
      if(n<3)assert.ok(Math.abs(new Date(row.next_try_at)-Date.now()-(n===1?5:15)*60000)<5000);
    }
    await db.query('SELECT public.eeum_photo_ai_backfill(NULL,1000)');
    assert.equal((await job('POL-RETRY-1')).attempts,3);assert.equal((await job('POL-RETRY-1')).state,'failed');
  });
  await check('사진 변경 중 완료 거부·이전 결과 비공개 보존', async () => {
    await add('POL-STALE-1'); await control('pilot','POL-STALE-1');await advance();
    const j=(await claim('POL-STALE-1')).job;
    await db.query("UPDATE storage.objects SET version='v2' WHERE name='api/POL-STALE-1.jpg'");
    assert.equal((await finish(j)).committed,false);assert.equal((await job(j.item_id)).state,'pending');
  });
  await check('수령 완료 및 출처 변경 무효화·보관 상태 재개', async () => {
    await add('POL-REOPEN-1'); await control('pilot','POL-REOPEN-1'); await advance();
    const j=(await claim('POL-REOPEN-1')).job;
    await db.query("UPDATE public.items SET status='수령완료' WHERE id=$1",[j.item_id]);
    assert.equal((await finish(j)).committed,false); assert.equal((await job(j.item_id)).state,'cancelled');
    await db.query("UPDATE public.items SET status='보관중' WHERE id=$1",[j.item_id]);assert.equal((await job(j.item_id)).state,'pending');
    await db.query('UPDATE public.items SET created_by=$1 WHERE id=$2',[owner,j.item_id]);assert.equal((await job(j.item_id)).state,'cancelled');
  });
  await check('임대 만료 복구와 이전 lease의 새 작업 방해 차단', async () => {
    await add('POL-LEASE-1'); await control('pilot','POL-LEASE-1');await advance();
    const old=(await claim('POL-LEASE-1')).job;
    await db.exec("UPDATE eeum_photo_ai.control SET active_until=now()-interval '1 minute',next_start_at=now()-interval '1 minute'");
    await claim('POL-LEASE-1'); assert.equal((await job(old.item_id)).state,'retry');
    await advance(old.item_id); const fresh=(await claim(old.item_id)).job;
    assert.notEqual(fresh.lease_id,old.lease_id);assert.equal((await finish(old)).committed,false);
    assert.equal((await db.query('SELECT active_lease FROM eeum_photo_ai.control')).rows[0].active_lease,fresh.lease_id);
    await finish(fresh);
  });
  await check('일일 예산과 한국 날짜 갱신', async () => {
    await db.exec('UPDATE eeum_photo_ai.control SET daily_starts=0');
    await add('POL-BUDGET-1');await add('POL-BUDGET-2');await control('pilot','POL-PILOT-1');await control('all',null,1);await advance();
    await finish((await claim('POL-BUDGET-1')).job);await advance();assert.equal((await claim('POL-BUDGET-2')).reason,'daily_limit');
    await db.exec("UPDATE eeum_photo_ai.control SET daily_date=daily_date-1");
    await finish((await claim('POL-BUDGET-2')).job);
  });
  await check('DB 허용표 밖 결과·PII 자유문 거부', async () => {
    await add('POL-INVALID-1');await control('pilot','POL-INVALID-1');await advance();
    const j=(await claim('POL-INVALID-1')).job;
    await assert.rejects(()=>finish(j,'succeeded',analysis(j,{materials:['PERSONAL_TEXT_NOT_ALLOWED']})),/invalid_photo_tags/);
    await assert.rejects(()=>finish(j,'succeeded',analysis(j,{materials:[null]})),/invalid_photo_tags/);
    await assert.rejects(()=>finish(j,'succeeded',analysis(j,{photo_features:['전화 01012345678']})),/invalid_private_photo_features/);
    await finish(j,'failed',null,'invalid_result');assert.equal((await job(j.item_id)).result,null);
  });
  await check('작업자 무인증 차단·빈 요청 Dry Run 무변경', async () => {
    let calls=0;const worker=createPhotoWorker({base,serviceKey,secret,db:{rpc:()=>{calls++;return Promise.resolve({data:{mode:'off'},error:null});}}});
    assert.equal((await worker(new Request(base,{method:'POST'}))).status,403);assert.equal(calls,0);
    const dry=await(await worker(request({}))).json();assert.equal(dry.dryRun,true);assert.equal(calls,1);
  });
  await check('작업자 진입점: 전용 Secret 우선·기존 CRON_SECRET 재사용', async () => {
    const source=fs.readFileSync(path.join(root,'supabase/functions/auto-analyze-items/index.ts'),'utf8');
    const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    for(const dedicated of [undefined,'LOCAL_DEDICATED_SECRET_123456789012345']){
      let actual;
      const env={SUPABASE_URL:base,SUPABASE_SERVICE_ROLE_KEY:serviceKey,CRON_SECRET:secret,PHOTO_AI_WORKER_SECRET:dedicated};
      const ctx={exports:{},require:name=>name.startsWith('npm:')?{createClient:()=>rpcAdapter()}:{createPhotoWorker:options=>{actual=options.secret;return()=>{};}},Deno:{env:{get:key=>env[key]},serve:()=>{}}};
      vm.createContext(ctx);vm.runInContext(compiled,ctx);assert.equal(actual,dedicated||secret);
    }
  });
  await check('실제 작업자→기존 AI 핸들러→PostgreSQL 비공개 저장', async () => {
    await add('POL-E2E-1');await control('pilot','POL-E2E-1');await advance();
    const ai=aiHarness(); const worker=createPhotoWorker({base,serviceKey,secret,db:rpcAdapter(),fetcher:async(_url,init)=>ai.invoke(JSON.parse(init.body))});
    const value=await(await worker(request({dryRun:false,itemId:'POL-E2E-1'}))).json();
    assert.equal(value.committed,true);assert.equal(value.state,'review');assert.equal(ai.calls().geminiCalls,1);
    assert.deepEqual((await job('POL-E2E-1')).result.materials,['플라스틱']);
    await worker(request({dryRun:false,itemId:'POL-E2E-1'}));assert.equal(ai.calls().geminiCalls,1);
  });
  await check('수동 AI 요청 계약·기존 400 대체 호출 유지', async () => {
    const ai=aiHarness({rejectFirst:true}); const response=await ai.invoke({mode:'register',text:'가방 외형 확인',imageUrl:base+'/storage/v1/object/public/item-photos/api/POL-E2E-1.jpg'});
    const value=await response.json();assert.equal(response.status,200);assert.ok(value.result);assert.equal(value.photoAnalysis,undefined);assert.equal(ai.calls().geminiCalls,2);
  });
  await check('저장 응답 유실은 완료 RPC만 재전송하고 중복 반영하지 않음', async () => {
    await add('POL-SAVE-1');await control('pilot','POL-SAVE-1');await advance();
    const ai=aiHarness(), real=rpcAdapter();let saves=0;
    const adapter={rpc:async(name,args)=>{const value=await real.rpc(name,args);if(name==='eeum_photo_ai_finish'&&++saves===1)return{data:null,error:{code:'LOCAL_LOST_RESPONSE'}};return value;}};
    const worker=createPhotoWorker({base,serviceKey,secret,db:adapter,fetcher:async(_url,init)=>ai.invoke(JSON.parse(init.body))});
    const result=await(await worker(request({dryRun:false,itemId:'POL-SAVE-1'}))).json();
    assert.equal(result.committed,true);assert.equal(saves,2);assert.equal(ai.calls().geminiCalls,1);
    assert.equal((await job('POL-SAVE-1')).attempts,1);
  });
  await check('잘못된 성공 응답은 저장하지 않고 파이프라인 일시 중지', async () => {
    await add('POL-CONTRACT-1');await control('pilot','POL-CONTRACT-1');await advance();
    const worker=createPhotoWorker({base,serviceKey,secret,db:rpcAdapter(),fetcher:async()=>Response.json({result:{photoFeats:['가죽']}})});
    await worker(request({dryRun:false,itemId:'POL-CONTRACT-1'}));
    assert.equal((await job('POL-CONTRACT-1')).result,null);
    assert.equal((await db.query('SELECT pause_reason FROM eeum_photo_ai.control')).rows[0].pause_reason,'ai_contract_mismatch');
  });
  await check('시간 초과는 제한 재시도, 영구 이미지 오류는 자동 재등록하지 않음', async () => {
    await add('POL-TIMEOUT-1');await control('pilot','POL-TIMEOUT-1');await advance();
    const worker=createPhotoWorker({base,serviceKey,secret,db:rpcAdapter(),timeoutMs:5,
      fetcher:async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('local timeout','AbortError'))))});
    await worker(request({dryRun:false,itemId:'POL-TIMEOUT-1'}));assert.equal((await job('POL-TIMEOUT-1')).last_error,'timeout');
    await add('POL-BADIMAGE-1');await control('pilot','POL-BADIMAGE-1');await advance();
    const j=(await claim('POL-BADIMAGE-1')).job;await finish(j,'skipped',null,'bad_image');
    await db.query('SELECT public.eeum_photo_ai_backfill(NULL,1000)');assert.equal((await job(j.item_id)).state,'skipped');assert.equal((await job(j.item_id)).attempts,1);
  });
  await check('기존 담당자 삭제 기능 및 새 큐 종속 행 정리 유지', async () => {
    await add('POL-DELETE-1');
    await asRole('authenticated',owner,()=>db.query("DELETE FROM public.items WHERE id='POL-DELETE-1'"));
    assert.equal(await job('POL-DELETE-1'),undefined);
  });
  await check('공개 필터는 외형 어휘만 허용하고 이름·지시문·부정 표현 제외', async () => {
    const r=analysis(null,{color:null,materials:[],shapes:[],photo_features:['사피아노 패턴','덮개형','금속 로고','홍길동','가죽 아님','규칙 무시']});
    const value=(await db.query('SELECT eeum_photo_ai.public_features($1::jsonb) AS v',[JSON.stringify(r)])).rows[0].v;
    assert.deepEqual(value,['사피아노 패턴','덮개형','금속 로고']);
    assert.deepEqual((await db.query('SELECT eeum_photo_ai.public_features($1::jsonb) AS v',[JSON.stringify({...r,privacy:true})])).rows[0].v,[]);
  });
  await check('공개 자동 저장: 원래 설명 보존·특징 추가·변경 전 설명 비공개 백업', async () => {
    await db.exec('UPDATE eeum_photo_ai.control SET publish_public=true');
    await add('POL-PUBLIC-1');
    const original='프라다 지갑(검정색)을 습득하여 보관하고 있습니다.';
    await db.query('UPDATE public.items SET description=$1 WHERE id=$2',[original,'POL-PUBLIC-1']);
    await control('pilot','POL-PUBLIC-1');await advance();
    const j=(await claim('POL-PUBLIC-1')).job;
    await finish(j,'succeeded',analysis(j,{color:'검정',materials:[],shapes:[],photo_features:['사피아노 패턴','덮개형','금속 로고']}));
    const row=(await db.query("SELECT * FROM public.items WHERE id='POL-PUBLIC-1'")).rows[0];
    assert.equal(row.description,'프라다 지갑(검정색), 사피아노 패턴, 덮개형, 금속 로고');
    const backup=(await db.query("SELECT * FROM eeum_photo_ai.publications WHERE item_id='POL-PUBLIC-1'")).rows[0];
    assert.equal(backup.previous_description,'프라다 지갑(검정색)');assert.equal(backup.published_description,row.description);
    assert.equal((await db.query("SELECT previous_description FROM eeum_photo_ai.description_formats WHERE item_id='POL-PUBLIC-1' ORDER BY id LIMIT 1")).rows[0].previous_description,original);
    assert.equal(row.color,'검정');assert.equal(row.name,'LOCAL ITEM');
    assert.equal((await db.query("SELECT owner_check_memo FROM public.item_private WHERE item_id='POL-PUBLIC-1'")).rows[0].owner_check_memo,'KEEP ORIGINAL MEMO');
    await finish(j);await db.query("SELECT eeum_photo_ai.enqueue('POL-PUBLIC-1')");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM eeum_photo_ai.publications WHERE item_id='POL-PUBLIC-1'")).rows[0].n,1);
  });
  await check('기존 보강 문장과 신규 무사진 외부 물품도 추가 AI 호출 없이 정리·원문 보관', async () => {
    await control('all');
    const attempts=(await job('POL-FORMATOLD-1')).attempts;
    await db.query("SELECT eeum_photo_ai.enqueue('POL-FORMATOLD-1')");
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-FORMATOLD-1'")).rows[0].description,'카드지갑(검정색), 덮개형');
    assert.equal((await job('POL-FORMATOLD-1')).attempts,attempts);
    assert.equal((await job('POL-FORMATOLD-1')).state,'review');
    const raw='휴대폰(갤럭시 S23)을 습득하여 보관하고 있습니다.';
    await add('POL-FORMATNEW-1',{photo:null,description:raw});
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-FORMATNEW-1'")).rows[0].description,'휴대폰(갤럭시 S23)');
    assert.equal(await job('POL-FORMATNEW-1'),undefined);
    await add('POL-FORMATSTAFF-1',{photo:null,description:raw});
    await db.query("UPDATE public.items SET description='담당자가 나중에 바꾼 문장' WHERE id='POL-FORMATSTAFF-1'");
    await add('POL-FORMATOWN-1',{createdBy:owner,description:raw});
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-FORMATOWN-1'")).rows[0].description,raw);
  });
  await check('공개 자동 저장: 분석 중 담당자 수정과 이미 포함된 특징 보존', async () => {
    await add('POL-PUBSTAFF-1');await control('pilot','POL-PUBSTAFF-1');await advance();
    const j=(await claim('POL-PUBSTAFF-1')).job;
    await db.query("UPDATE public.items SET description='담당자가 작성한 특징, 퀼팅' WHERE id=$1",[j.item_id]);
    await finish(j,'succeeded',analysis(j,{photo_features:['퀼팅','퀼팅','금속 로고'],color:null,materials:[],shapes:[]}));
    assert.equal((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description,'담당자가 작성한 특징, 퀼팅, 금속 로고');
    await db.query("UPDATE public.items SET description='담당자가 저장 후 다시 수정' WHERE id=$1",[j.item_id]);
    await db.query('SELECT eeum_photo_ai.enqueue($1)',[j.item_id]);
    assert.equal((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description,'담당자가 저장 후 다시 수정');
  });
  await check('개인정보 의심·사진 변경 결과는 공개 저장하지 않음', async () => {
    await add('POL-PUBPRIVACY-1');await control('pilot','POL-PUBPRIVACY-1');await advance();
    let j=(await claim('POL-PUBPRIVACY-1')).job;
    await finish(j,'succeeded',analysis(j,{privacy:true,photo_features:[]}));
    assert.equal((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description,'ORIGINAL DESCRIPTION');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.publications WHERE item_id=$1',[j.item_id])).rows[0].n,0);
    await add('POL-PUBSTALE-1');await control('pilot','POL-PUBSTALE-1');await advance();
    j=(await claim('POL-PUBSTALE-1')).job;
    await db.query("UPDATE storage.objects SET version='v2' WHERE name=$1",['api/'+j.item_id+'.jpg']);
    await finish(j);
    assert.equal((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description,'ORIGINAL DESCRIPTION');
    await control('off');
  });
  await check('중지 중 완료는 비공개 저장, 재개 시 캐시만 공개하고 추가 분석하지 않음', async () => {
    await add('POL-PUBPAUSE-1');await control('pilot','POL-PUBPAUSE-1');await advance();
    const j=(await claim('POL-PUBPAUSE-1')).job;await control('off');await finish(j);
    assert.equal((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description,'ORIGINAL DESCRIPTION');
    await control('pilot',j.item_id);await db.query('SELECT eeum_photo_ai.enqueue($1)',[j.item_id]);
    assert.ok((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description.includes('퀼팅'));
    assert.equal((await job(j.item_id)).attempts,1);
  });
  await check('공개 저장 실패는 분석 결과 보존 후 캐시로 저장만 재시도', async () => {
    await add('POL-PUBRETRY-1');await control('pilot','POL-PUBRETRY-1');await advance();
    const j=(await claim('POL-PUBRETRY-1')).job;
    await db.exec(`CREATE FUNCTION public.local_publication_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='POL-PUBRETRY-1' THEN RAISE EXCEPTION 'local_publication_failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER local_publication_failure BEFORE UPDATE OF description ON public.items FOR EACH ROW EXECUTE FUNCTION public.local_publication_failure();`);
    await finish(j);
    assert.equal((await job(j.item_id)).state,'review');assert.equal((await job(j.item_id)).last_error,'public_feature_publish_failed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.publications WHERE item_id=$1',[j.item_id])).rows[0].n,0);
    await db.exec('DROP TRIGGER local_publication_failure ON public.items;DROP FUNCTION public.local_publication_failure()');
    await db.query('SELECT eeum_photo_ai.enqueue($1)',[j.item_id]);
    assert.equal((await job(j.item_id)).last_error,null);assert.equal((await job(j.item_id)).attempts,1);
    assert.ok((await db.query('SELECT description FROM public.items WHERE id=$1',[j.item_id])).rows[0].description.includes('퀼팅'));
  });
  await check('동일 사진 재업로드는 ETag로 중복 차단, 실제 사진 변경만 새 분석', async () => {
    await add('POL-PUBETAG-1',{etag:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'});
    await control('pilot','POL-PUBETAG-1');await advance();
    const first=(await claim('POL-PUBETAG-1')).job;await finish(first);
    await db.query("UPDATE storage.objects SET version='v2',updated_at=clock_timestamp() WHERE name=$1",['api/'+first.item_id+'.jpg']);
    await db.query('SELECT eeum_photo_ai.enqueue($1)',[first.item_id]);
    assert.equal((await job(first.item_id)).state,'review');assert.equal((await job(first.item_id)).attempts,1);
    assert.equal((await job(first.item_id)).source_version,first.source_version);
    await db.query("UPDATE storage.objects SET version='v3',metadata=jsonb_set(metadata,'{eTag}',$2::jsonb) WHERE name=$1",['api/'+first.item_id+'.jpg',JSON.stringify('"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')]);
    await db.query('SELECT eeum_photo_ai.enqueue($1)',[first.item_id]);await advance();
    const second=(await claim(first.item_id)).job;assert.notEqual(second.source_version,first.source_version);
    await finish(second,'succeeded',analysis(second,{photo_features:['줄무늬'],color:null,materials:[],shapes:[]}));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.publications WHERE item_id=$1',[first.item_id])).rows[0].n,2);
  });
  await check('공개 변경 전 백업과 복구 RPC는 시민·담당자·작업자 직접 접근 차단', async () => {
    for(const role of ['anon','authenticated','service_role'])await asRole(role,owner,async()=>{
      await assert.rejects(()=>db.query('SELECT * FROM eeum_photo_ai.publications'),e=>e.code==='42501');
      await assert.rejects(()=>db.query('SELECT * FROM eeum_photo_ai.description_formats'),e=>e.code==='42501');
      await assert.rejects(()=>db.query('SELECT public.eeum_photo_ai_restore_public()'),e=>e.code==='42501');
    });
  });
  await check('공개 특징 복구는 최신 자동 추가부터 되돌리고 담당자 후속 수정은 유지', async () => {
    const n=(await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.publications')).rows[0].n;
    await assert.rejects(()=>db.query('SELECT public.eeum_photo_ai_restore_public()'),/pause_and_wait_first/);
    await control('off');
    const restored=(await db.query('SELECT public.eeum_photo_ai_restore_public() AS v')).rows[0].v;
    assert.ok(restored.restored>=1);assert.ok(restored.skipped_staff_changes>=1);
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-PUBETAG-1'")).rows[0].description,'ORIGINAL DESCRIPTION');
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-PUBSTAFF-1'")).rows[0].description,'담당자가 저장 후 다시 수정');
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-FORMATSTAFF-1'")).rows[0].description,'담당자가 나중에 바꾼 문장');
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-FORMATNEW-1'")).rows[0].description,'휴대폰(갤럭시 S23)을 습득하여 보관하고 있습니다.');
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-PUBLIC-1'")).rows[0].description,'프라다 지갑(검정색)을 습득하여 보관하고 있습니다.');
    assert.equal((await db.query("SELECT description FROM public.items WHERE id='POL-FORMATOLD-1'")).rows[0].description,'카드지갑(검정색)을 습득하여 보관하고 있습니다.');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.publications')).rows[0].n,n);
    assert.equal((await db.query('SELECT publish_public FROM eeum_photo_ai.control')).rows[0].publish_public,false);
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/93_restore_public_features.sql'),'utf8'));
  });
  await check('Cron은 비활성 생성·기존 작업 유지·이름별 Secret 검사', async () => {
    await db.exec(`CREATE SCHEMA cron;CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text,schedule text,command text,active boolean DEFAULT true);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid$$;
      CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL)
      RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET active=coalesce($6,cron.job.active) WHERE jobid=$1$$;
      CREATE SCHEMA net;CREATE FUNCTION net.http_post(text,jsonb DEFAULT '{}',jsonb DEFAULT '{}',jsonb DEFAULT '{}',integer DEFAULT 1000) RETURNS bigint LANGUAGE sql AS $$SELECT 1::bigint$$;
      CREATE SCHEMA vault;CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
      INSERT INTO cron.job(jobname,schedule,command) VALUES('existing-team-job','0 * * * *','SELECT 1');
      INSERT INTO vault.decrypted_secrets VALUES('eeum_photo_ai_worker_secret','${secret}'),('eeum_photo_ai_worker_secret','${secret}');`);
    const cron=fs.readFileSync(path.join(root,'supabase/photo-ai/04_create_cron_disabled.sql'),'utf8');
    await assert.rejects(()=>db.exec(cron),/vault_name_count_mismatch/);await db.exec('ROLLBACK');
    await db.exec(`DELETE FROM vault.decrypted_secrets;INSERT INTO vault.decrypted_secrets VALUES('eeum_photo_ai_project_url','${base}'),('eeum_photo_ai_worker_secret','${secret}');`);
    await db.exec(cron);
    assert.equal((await db.query("SELECT active FROM cron.job WHERE jobname='eeum-photo-ai-v1'")).rows[0].active,false);
    assert.equal((await db.query("SELECT active FROM cron.job WHERE jobname='existing-team-job'")).rows[0].active,true);
    await db.exec(`DELETE FROM cron.job WHERE jobname='eeum-photo-ai-v1';DELETE FROM vault.decrypted_secrets;
      INSERT INTO vault.decrypted_secrets VALUES('project_url','${base}'),('cron_secret','${secret}');`);
    await db.exec(cron);
    assert.ok((await db.query("SELECT command FROM cron.job WHERE jobname='eeum-photo-ai-v1'")).rows[0].command.includes("name='cron_secret'"));
    await control('pilot','POL-PILOT-1');
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/05_enable_new_only.sql'),'utf8'));
    assert.equal((await db.query('SELECT mode FROM eeum_photo_ai.control')).rows[0].mode,'new');
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/07_enable_public_all.sql'),'utf8'));
    assert.equal((await db.query('SELECT mode FROM eeum_photo_ai.control')).rows[0].mode,'all');
    assert.equal((await db.query('SELECT daily_limit FROM eeum_photo_ai.control')).rows[0].daily_limit,300);
    assert.equal((await db.query('SELECT publish_public FROM eeum_photo_ai.control')).rows[0].publish_public,true);
    assert.equal((await job('POL-ETAGLEGACY-1')).attempts,1);
    assert.equal((await db.query("SELECT active FROM cron.job WHERE jobname='eeum-photo-ai-v1'")).rows[0].active,true);
  });
  await check('중지·데이터 보존 롤백·연결 복구', async () => {
    const jobsBefore=(await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.jobs')).rows[0].n;
    const resultBefore=(await db.query("SELECT result FROM eeum_photo_ai.jobs WHERE item_id='POL-E2E-1'")).rows[0].result;
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/90_pause.sql'),'utf8'));
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/91_rollback_keep_data.sql'),'utf8'));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.items'::regclass AND NOT tgisinternal")).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM eeum_photo_ai.jobs')).rows[0].n,jobsBefore);
    assert.deepEqual((await db.query("SELECT result FROM eeum_photo_ai.jobs WHERE item_id='POL-E2E-1'")).rows[0].result,resultBefore);
    assert.equal((await db.query("SELECT active FROM cron.job WHERE jobname='existing-team-job'")).rows[0].active,true);
    await db.exec(fs.readFileSync(path.join(root,'supabase/photo-ai/92_restore_trigger.sql'),'utf8'));
    assert.equal((await db.query('SELECT mode FROM eeum_photo_ai.control')).rows[0].mode,'off');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.items'::regclass AND NOT tgisinternal")).rows[0].n,2);
  });
  await check('원본 파일럿·Cron·운영 네트워크를 실행하지 않는 검사 범위', async () => {
    const inline=fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/g);
    for(const script of inline||[])new vm.Script(script.replace(/^<script>|<\/script>$/g,''));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='items' AND column_name LIKE 'ai_photo_%'")).rows[0].n,0);
  });
  console.log(JSON.stringify({checks:passed.length,engine:(await db.query('SELECT version() AS v')).rows[0].v,
    production_mutations:0,real_Gemini_calls:0,multi_session_concurrency:'not tested',checks_passed:passed},null,2));
}
main().then(()=>db?.close()).catch(async error=>{console.error(error);await db?.close();process.exitCode=1;});
// 고현 수정 끝: 실제 PostgreSQL 로직과 격리된 HTTP를 사용하는 사진 자동화 검증
