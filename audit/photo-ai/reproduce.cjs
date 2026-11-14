// 고현 수정 시작: 첨부 C안의 주장과 실제 동작을 비교하는 로컬 전용 재현 검사
// 운영 URL, 운영 키, 실제 이미지, Gemini를 사용하지 않습니다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { PGlite } = require('@electric-sql/pglite');

const repo = path.resolve(__dirname, '../..');
const draft = path.resolve(process.argv[2] || process.env.C_V2_ROOT || '');
if (!fs.existsSync(path.join(draft, 'sql/01_schema_and_queue.sql'))) {
  throw new Error('ZIP을 별도 폴더에 해제하고 그 경로를 첫 번째 인자로 지정하세요.');
}
const findings = [];
function record(name, evidence) { findings.push({ name, evidence }); }
function contextFor(source, fetcher = async () => { throw new Error('unexpected fetch'); }) {
  const sandbox = {
    URL, Response, Request, Headers, Uint8Array, AbortController, setTimeout, clearTimeout,
    btoa, Date, console: { info() {}, warn() {}, error() {} },
    Deno: { env: { get: key => ({ IMAGE_URL_HOSTS: 'example-project.supabase.co' })[key] } },
    fetch: fetcher,
  };
  vm.createContext(sandbox);
  const beforeHandler = source.slice(0, source.indexOf('Deno.serve('))
    .replace(/^import .*createClient.*;\s*$/m, '');
  vm.runInContext(ts.transpileModule(beforeHandler, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText.replace(/Object\.defineProperty\(exports,[^\n]+\n/g, '')
    .replace(/^exports\.[^\n]*\n/gm, ''), sandbox);
  return sandbox;
}

async function main() {
  const worker = fs.readFileSync(path.join(draft, 'supabase/functions/auto-analyze-items/index.ts'), 'utf8');
  const wc = contextFor(worker);
  const base = 'https://example-project.supabase.co';
  const id = 'POL-F2026111200005394-1';
  assert.equal(wc.imageUrl('api/OTHER.jpg', base, id), null);
  const other = `${base}/storage/v1/object/public/item-photos/api/OTHER.jpg`;
  assert.equal(wc.imageUrl(other, base, id), other);
  record('absolute_storage_URL_does_not_bind_item_ID', { relative_other: null, absolute_other: 'accepted' });
  const negation = [...wc.safeFeatures(['불투명', '가죽이 아닌 플라스틱', '무광 아님'])];
  assert.deepEqual(negation, ['투명', '가죽', '무광']);
  record('substring_normalization_reverses_negation', negation);
  assert.deepEqual([...wc.safeFeatures(['빨강', '플라스틱'])], []);
  record('color_and_common_material_not_saved', { color_and_plastic: 'discarded' });
  assert.equal(wc.canRetry(502, 'gemini_http_401'), true);
  assert.equal(wc.canRetry(503, 'no_model'), true);
  assert.equal(wc.canRetry(502, 'image_http_408'), false);
  record('retry_classification_mismatch', { permanent_gemini_401: 'retry', missing_model: 'retry', transient_image_408: 'terminal' });

  // 실제 작업자 핸들러를 캡처하되 DB RPC와 모든 HTTP는 로컬 가짜 응답으로 대체합니다.
  let handler;
  const calls = [];
  let responseBody = { result: { photoFeats: ['가죽'], privacy: false, color: '빨강' } };
  let responseStatus = 200;
  const fakeSecret = 'LOCAL_ONLY_NOT_A_REAL_SECRET_12345';
  const fakeJob = { item_id: id, photo_path: `api/${id}.jpg`, lease_id: '22222222-2222-4222-8222-222222222222' };
  wc.Deno.env.get = key => ({ CRON_SECRET: fakeSecret, SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'LOCAL_ONLY_FAKE_SERVICE_KEY' })[key];
  wc.Deno.serve = fn => { handler = fn; };
  wc.createClient = () => ({
    rpc: async (name, params) => {
      calls.push({ name, params });
      return { data: name === 'eeum_claim_photo_ai' ? [fakeJob] : true, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { id, photo_path: fakeJob.photo_path, created_by: null, status: '보관중' }, error: null,
    }) }) }) }),
  });
  wc.fetch = async (url, options) => {
    assert.equal(url, `${base}/functions/v1/ai-parse`);
    const body = JSON.parse(options.body);
    assert.equal(body.text, '습득물 사진의 외형 특징을 확인합니다.');
    calls.push({ name: 'mock_ai_http' });
    return new Response(JSON.stringify(responseBody), { status: responseStatus, headers: { 'content-type': 'application/json' } });
  };
  vm.runInContext(ts.transpileModule(worker.slice(worker.indexOf('Deno.serve(')), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, wc);
  assert.equal((await handler(new Request('https://local.invalid', { method: 'POST' }))).status, 403);
  assert.equal(calls.length, 0);
  const invoke = () => handler(new Request('https://local.invalid', {
    method: 'POST', headers: { 'x-cron-secret': fakeSecret },
  }));
  const normalHTTP = await (await invoke()).json();
  assert.equal(normalHTTP.committed, true);
  assert.equal(normalHTTP.status, 'done');
  const successfulFinish = calls.find(row => row.name === 'eeum_finish_photo_ai');
  assert.deepEqual([...successfulFinish.params.p_features], ['가죽']);
  assert.equal('p_color' in successfulFinish.params, false);
  record('worker_handler_mock_normal_and_unauthorized', { unauthorized: 403, normal: 'done', color_in_AI_response: 'not persisted', network: 'stubbed' });
  calls.length = 0;
  responseStatus = 502; responseBody = { reason: 'gemini_http_401' };
  await invoke();
  assert.equal(calls.find(row => row.name === 'eeum_finish_photo_ai').params.p_retryable, true);
  record('worker_handler_mock_failure', 'Gemini permanent 401 is requested for retry');

  // 원안 재현은 이후 수정 파일이 아니라 최초 검토한 커밋을 사용합니다.
  const aiSource = execFileSync('git', ['show', '4dbc2fde73d5dbbec8c2dab5406fabe56fde7806:supabase/functions/ai-parse/index.ts'], { cwd: repo, encoding: 'utf8' });
  let fixture = {};
  const ac = contextFor(aiSource, async () => {
    const bytes = new Uint8Array(fixture.size || 128);
    bytes.set([0xff, 0xd8, 0xff]);
    return new Response(bytes, { headers: { 'content-type': fixture.mime || 'image/jpeg' } });
  });
  for (const [size, accepted] of [[7_999_999, true], [8_000_000, true], [8_000_001, false], [8_388_608, false]]) {
    fixture = { size };
    const result = await ac.fetchImage(`${base}/photo.jpg`, Date.now() + 25_000);
    assert.equal(!!result.image, accepted);
    if (!accepted) assert.equal(result.reason, 'image_download_too_large');
  }
  for (const mime of ['image/gif', 'image/heic']) {
    fixture = { size: 128, mime };
    assert.equal((await ac.fetchImage(`${base}/photo`, Date.now() + 25_000)).reason, 'bad_image_type');
  }
  record('remote_image_boundaries', { accepted_bytes: 8_000_000, rejected_bytes: 8_000_001, remote_gif_heic: 'rejected', fixture: 'synthetic JPEG signature, not a decoded real image' });
  assert.equal(ac.hostOk('https://nested.example-project.supabase.co/photo.jpg'), true);
  record('IMAGE_URL_HOSTS_also_allows_subdomains', true);

  const db = new PGlite();
  try {
    const version = (await db.query('select version() as version')).rows[0].version;
    // Supabase 고유 auth/storage/cron 요소만 최소 스텁. 공개 테이블/RLS/트리거는 브랜치 원문 사용.
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text, name text, metadata jsonb);
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
        $$ SELECT string_to_array($1, '/') $$;
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobid bigint, jobname text, schedule text, active boolean, command text);
      CREATE SCHEMA vault;
      CREATE TABLE vault.decrypted_secrets (name text);
    `);
    await db.exec(execFileSync('git', ['show', '4dbc2fde73d5dbbec8c2dab5406fabe56fde7806:supabase/1_schema.sql'], { cwd: repo, encoding: 'utf8' }));
    for (const file of ['01_readonly_catalog.sql', '02_readonly_counts_and_storage.sql', '03_readonly_scheduler.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    }
    record('new_readonly_diagnostics_execute_on_local_fixture', '3 SQL files, read-only transactions');
    let preflightError;
    try { await db.exec(fs.readFileSync(path.join(draft, 'sql/00_preflight.sql'), 'utf8')); }
    catch (error) { preflightError = { code: error.code, message: error.message }; }
    assert.equal(preflightError.code, '42703');
    assert.match(preflightError.message, /i\.relname/);
    record('original_preflight_SQL_fails', preflightError);
    await db.exec(fs.readFileSync(path.join(draft, 'sql/01_schema_and_queue.sql'), 'utf8'));
    record('draft_migration_applies_on_repository_schema', { engine: version, production_equivalence: false });
    await db.exec(`
      INSERT INTO public.orgs (name, kind) VALUES ('LOCAL TEST ORG', '경찰서');
      INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO public.staff_members (user_id, org_id) VALUES ('11111111-1111-4111-8111-111111111111', 1);
    `);
    async function insert(item, photo = `api/${item}.jpg`, status = '보관중') {
      await db.query(`INSERT INTO public.items (id,kind,name,category,found_on,org_id,photo_path,created_by,description,status)
        VALUES ($1,'경찰서','LOCAL TEST','가방','2026-11-14',1,$2,NULL,'ORIGINAL DESCRIPTION',$3)`, [item, photo, status]);
    }
    async function claim() { return (await db.query('SELECT * FROM public.eeum_claim_photo_ai()')).rows; }
    async function finish(job, ok = true, retry = false, reason = null) {
      return (await db.query(`SELECT public.eeum_finish_photo_ai($1,$2,$3,$4,ARRAY['가죽','퀼팅'],false,$5,$6) AS committed`,
        [job.item_id, job.photo_path, job.lease_id, ok, retry, reason])).rows[0].committed;
    }
    async function item(itemID) { return (await db.query('SELECT * FROM public.items WHERE id=$1', [itemID])).rows[0]; }

    await insert('POL-NORMAL-1');
    await db.query(`INSERT INTO public.item_private (item_id,owner_check_memo) VALUES ('POL-NORMAL-1','KEEP ORIGINAL MEMO')`);
    assert.equal((await item('POL-NORMAL-1')).ai_photo_status, 'pending');
    const [normal] = await claim();
    assert.equal((await claim()).length, 0);
    assert.equal(await finish(normal), true);
    assert.equal(await finish(normal), false);
    const priv = (await db.query(`SELECT * FROM public.item_private WHERE item_id='POL-NORMAL-1'`)).rows[0];
    assert.equal(priv.owner_check_memo, 'KEEP ORIGINAL MEMO');
    assert.deepEqual(priv.ai_photo_features, ['가죽', '퀼팅']);
    assert.equal((await item(normal.item_id)).description, 'ORIGINAL DESCRIPTION');
    record('normal_completion_and_duplicate_finish', { state: 'done', duplicate_commit: false, original_memo_and_description: 'preserved' });

    await insert('POL-NOPHOTO-1', null);
    await insert('POL-PLACEHOLDER-1', `${base}/storage/v1/object/public/item-photos/no_image.jpeg`);
    assert.equal((await item('POL-NOPHOTO-1')).ai_photo_status, 'not_applicable');
    assert.equal((await item('POL-PLACEHOLDER-1')).ai_photo_status, 'not_applicable');
    record('null_and_placeholder_exclusion', 'passed');

    await insert('POL-RETRY-1');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [job] = await claim();
      assert.equal(job.item_id, 'POL-RETRY-1');
      assert.equal(await finish(job, false, true, 'timeout'), true);
      const row = await item(job.item_id);
      assert.equal(row.ai_photo_attempts, attempt);
      assert.equal(row.ai_photo_status, attempt < 3 ? 'retry' : 'failed');
      if (attempt < 3) {
        const gap = new Date(row.ai_photo_next_try_at).valueOf() - Date.now();
        assert.ok(Math.abs(gap - (attempt === 1 ? 5 : 15) * 60_000) < 5_000);
        await db.query(`UPDATE public.items SET ai_photo_next_try_at=now()-interval '1 second' WHERE id=$1`, [job.item_id]);
      }
    }
    record('retry_5m_15m_then_third_attempt_terminal', 'passed');

    await insert('POL-PHOTOCHANGE-1');
    const [old] = await claim();
    await db.query(`UPDATE public.items SET photo_path='api/POL-PHOTOCHANGE-1.png' WHERE id=$1`, [old.item_id]);
    assert.equal(await finish(old), false);
    const [fresh] = await claim();
    assert.notEqual(fresh.lease_id, old.lease_id);
    assert.equal(await finish(fresh), true);
    record('photo_path_change_rejects_stale_lease', 'passed');
    await db.query(`UPDATE public.items SET photo_path=photo_path WHERE id=$1`, [fresh.item_id]);
    assert.equal((await item(fresh.item_id)).ai_photo_status, 'done');
    record('same_storage_path_has_no_reanalysis_signal', 'state remains done; content changes are not observable in items');

    await insert('POL-RECEIVE-1');
    const [received] = await claim();
    await db.query(`UPDATE public.items SET status='수령완료' WHERE id=$1`, [received.item_id]);
    assert.equal(await finish(received), false);
    await db.query(`UPDATE public.items SET status='보관중' WHERE id=$1`, [received.item_id]);
    assert.equal((await item(received.item_id)).ai_photo_status, 'not_applicable');
    record('received_invalidates_lease_but_reopen_not_enqueued', 'not_applicable after reopen');

    await insert('POL-EXPIRED-1');
    const [expired] = await claim();
    await db.query(`UPDATE public.items SET ai_photo_claimed_at=now()-interval '3 minutes' WHERE id=$1`, [expired.item_id]);
    const [reclaimed] = await claim();
    assert.equal(reclaimed.item_id, expired.item_id);
    assert.notEqual(reclaimed.lease_id, expired.lease_id);
    assert.equal(await finish(expired), false);
    assert.equal(await finish(reclaimed), true);
    record('expired_lease_recovery_rejects_old_finish', 'passed; external Gemini exactly-once is not established');

    await insert('POL-CAPONE-1');
    await insert('POL-CAPTWO-1');
    const [one] = await claim();
    const [two] = await claim();
    assert.ok(one && two && one.item_id !== two.item_id);
    record('no_global_one_job_per_minute_gate', { immediate_claims: 2, different_items: true, note: 'sequential claims alone disprove the advertised cap; multi-session locking not tested' });
    await finish(one); await finish(two);

    await insert('POL-PILOTNEW-1');
    await insert('POL-PILOTCHOSEN-1');
    await db.query(`UPDATE public.items SET ai_photo_next_try_at=now()-interval '1 minute' WHERE id='POL-PILOTNEW-1'`);
    await db.query(`UPDATE public.items SET ai_photo_status='not_applicable',ai_photo_next_try_at=NULL WHERE id='POL-PILOTCHOSEN-1'`);
    // README의 1건 선택은 target ID를 작업자 RPC에 전달하지 않습니다.
    await db.query(`UPDATE public.items SET ai_photo_status='pending',ai_photo_next_try_at=now() WHERE id='POL-PILOTCHOSEN-1'`);
    const [unscoped] = await claim();
    assert.equal(unscoped.item_id, 'POL-PILOTNEW-1');
    record('pilot_selection_does_not_scope_worker_claim', 'an earlier automatically enqueued item is claimed instead');
    await finish(unscoped);
    const [chosen] = await claim(); await finish(chosen);

    await db.exec('SET ROLE anon');
    const publicColumns = Object.keys((await db.query(`SELECT * FROM public.items WHERE id='POL-NORMAL-1'`)).rows[0]);
    assert.ok(publicColumns.includes('ai_photo_lease_id'));
    let denied;
    try { await db.query('SELECT ai_photo_features FROM public.item_private'); } catch (e) { denied = e.code; }
    assert.equal(denied, '42501');
    await db.exec('RESET ROLE');
    record('repository_RLS_private_denied_but_public_queue_columns_visible', { anon_private: '42501', public_queue_columns_visible: true });

    await db.exec(`SET ROLE authenticated; SET "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';`);
    await db.query(`UPDATE public.item_private SET ai_photo_features=ARRAY['ALLOWLIST_BYPASS_TEST'] WHERE item_id='POL-NORMAL-1'`);
    await db.exec('RESET ROLE');
    assert.deepEqual((await db.query(`SELECT ai_photo_features FROM public.item_private WHERE item_id='POL-NORMAL-1'`)).rows[0].ai_photo_features, ['ALLOWLIST_BYPASS_TEST']);
    record('staff_can_bypass_AI_feature_allowlist_by_direct_private_update', 'table-level UPDATE grant covers added columns');

    await db.exec(`SET ROLE authenticated; SET "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';`);
    assert.equal((await db.query('SELECT * FROM public.item_private')).rows.length, 0);
    await db.exec('RESET ROLE');
    record('repository_RLS_authenticated_nonstaff_sees_no_private_rows', 'passed on repository policy');

    record('test_scope', { PostgreSQL: 'PGlite single session', Supabase_auth_storage_cron: 'stubs', Gemini_network: 'none', production_mutations: 'none', real_image_pilot: 'not run' });
    console.log(JSON.stringify({ observations: findings.length, findings }, null, 2));
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
// 고현 수정 끝: 첨부 C안의 주장과 실제 동작을 비교하는 로컬 전용 재현 검사
