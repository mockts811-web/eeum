-- 고현 수정 시작: 비공개 사진 분석 큐. 운영 적용은 별도 승인 후에만 실행합니다.
-- 기존 items/item_private 컬럼·데이터·RLS·GRANT와 다른 팀원의 함수는 변경하지 않습니다.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF to_regnamespace('eeum_photo_ai') IS NOT NULL THEN RAISE EXCEPTION 'photo_ai_already_installed'; END IF;
  IF to_regclass('public.item_photo_ai_jobs') IS NOT NULL THEN RAISE EXCEPTION 'existing_B_queue_requires_review'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname LIKE 'eeum_photo_ai_%') THEN
    RAISE EXCEPTION 'photo_ai_function_name_collision';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.items'::regclass
                 AND attname='id' AND atttypid='text'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'items_id_schema_mismatch';
  END IF;
  IF to_regclass('storage.objects') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid='storage.objects'::regclass
      AND attname IN ('version','updated_at') AND NOT attisdropped
  ) THEN RAISE EXCEPTION 'storage_version_metadata_required'; END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='storage.objects'::regclass
      AND attname IN ('id','bucket_id','name','metadata') AND NOT attisdropped)<>4 THEN
    RAISE EXCEPTION 'storage_objects_schema_mismatch';
  END IF;
END $$;

CREATE SCHEMA eeum_photo_ai;
REVOKE ALL ON SCHEMA eeum_photo_ai FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE eeum_photo_ai.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','pilot','new','all')),
  project_url text NOT NULL DEFAULT 'https://xhvthvxpwlaecizqlrrv.supabase.co',
  pilot_item_id text,
  daily_limit integer NOT NULL DEFAULT 20 CHECK (daily_limit BETWEEN 1 AND 1440),
  daily_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Seoul')::date),
  daily_starts integer NOT NULL DEFAULT 0 CHECK (daily_starts >= 0),
  next_start_at timestamptz NOT NULL DEFAULT now(),
  active_lease uuid, active_until timestamptz,
  reconcile_after text,
  pause_reason text,
  CHECK (mode <> 'pilot' OR pilot_item_id IS NOT NULL)
);
INSERT INTO eeum_photo_ai.control(singleton) VALUES (true);

CREATE TABLE eeum_photo_ai.jobs (
  item_id text PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  photo_path text NOT NULL,
  source_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','processing','retry','review','failed','skipped','cancelled')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_try_at timestamptz DEFAULT now(), lease_id uuid, claimed_at timestamptz,
  last_finished_lease uuid, last_finished_action text,
  last_error text,
  result jsonb, result_source_version text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result IS NULL OR jsonb_typeof(result)='object')
);
CREATE INDEX photo_ai_due_idx ON eeum_photo_ai.jobs(next_try_at,item_id)
  WHERE state IN ('pending','retry');
ALTER TABLE eeum_photo_ai.control ENABLE ROW LEVEL SECURITY;
ALTER TABLE eeum_photo_ai.jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA eeum_photo_ai FROM PUBLIC, anon, authenticated, service_role;

-- 사진과 물품 ID를 양쪽 경로 표현에서 동일하게 검사합니다. 원격 URL은 미러링 후 처리합니다.
CREATE FUNCTION eeum_photo_ai.source(p_id text, p_path text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' SET timezone='UTC' AS $$
DECLARE v_path text; v_base text; v_object jsonb; v_size numeric; v_mime text;
BEGIN
  IF coalesce(btrim(p_path),'')='' OR p_path ~* '(^|/)(no_image|no_img)\.(jpeg|jpg|png|gif)([?#].*)?$' THEN
    RETURN jsonb_build_object('eligible',false,'reason','no_photo');
  END IF;
  SELECT project_url INTO v_base FROM eeum_photo_ai.control WHERE singleton;
  v_path:=p_path;
  IF left(v_path,length(v_base||'/storage/v1/object/public/item-photos/'))=v_base||'/storage/v1/object/public/item-photos/' THEN
    v_path:=substr(v_path,length(v_base||'/storage/v1/object/public/item-photos/')+1);
  END IF;
  IF NOT (v_path=ANY(ARRAY['api/'||p_id||'.jpg','api/'||p_id||'.jpeg','api/'||p_id||'.png','api/'||p_id||'.webp'])) THEN
    RETURN jsonb_build_object('eligible',false,'reason',CASE WHEN p_path LIKE 'https://%' THEN 'external_photo_requires_mirror' ELSE 'invalid_photo_path' END);
  END IF;
  SELECT to_jsonb(o) INTO v_object FROM storage.objects o WHERE o.bucket_id='item-photos' AND o.name=v_path;
  IF v_object IS NULL THEN RETURN jsonb_build_object('eligible',false,'reason','storage_object_missing'); END IF;
  IF coalesce(v_object#>>'{metadata,size}','') !~ '^[0-9]{1,12}$' THEN
    RETURN jsonb_build_object('eligible',false,'reason','storage_size_unknown');
  END IF;
  v_size:=(v_object#>>'{metadata,size}')::numeric;
  v_mime:=lower(v_object#>>'{metadata,mimetype}');
  IF v_size>8000000 THEN RETURN jsonb_build_object('eligible',false,'reason','image_too_large'); END IF;
  IF v_size<100 THEN RETURN jsonb_build_object('eligible',false,'reason','bad_image'); END IF;
  IF v_mime IS NULL OR v_mime NOT IN ('image/jpeg','image/png','image/webp') THEN
    RETURN jsonb_build_object('eligible',false,'reason','bad_image_type');
  END IF;
  IF coalesce(v_object->>'version',v_object->>'updated_at','')='' THEN
    RETURN jsonb_build_object('eligible',false,'reason','storage_version_unknown');
  END IF;
  RETURN jsonb_build_object('eligible',true,'path',v_path,
    'version',md5(concat_ws('|','eeum-photo-v1',v_path,v_object->>'id',v_object->>'version',v_object->>'updated_at',v_size::text,v_mime)),
    'bytes',v_size,'mime',v_mime);
END $$;

CREATE FUNCTION eeum_photo_ai.enqueue(p_item_id text) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_item public.items%ROWTYPE; v_source jsonb; v_changed integer;
BEGIN
  SELECT * INTO v_item FROM public.items WHERE id=p_item_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_item.created_by IS NOT NULL OR v_item.status='수령완료' OR
    NOT (v_item.id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR v_item.id ~ '^[PFB][0-9]{13,}$') THEN
    UPDATE eeum_photo_ai.jobs SET state='cancelled',lease_id=NULL,claimed_at=NULL,next_try_at=NULL,
      last_error='item_not_eligible',updated_at=now() WHERE item_id=p_item_id AND state<>'cancelled';
    RETURN false;
  END IF;
  v_source:=eeum_photo_ai.source(v_item.id,v_item.photo_path);
  IF NOT (v_source->>'eligible')::boolean THEN
    -- 기본 이미지 등은 새 큐 행을 만들지 않습니다. 기존 결과는 비공개로 보존하며 무효화합니다.
    UPDATE eeum_photo_ai.jobs SET state='skipped',photo_path=coalesce(v_item.photo_path,''),lease_id=NULL,claimed_at=NULL,next_try_at=NULL,
      last_error=v_source->>'reason',updated_at=now() WHERE item_id=p_item_id
      AND (state<>'skipped' OR last_error IS DISTINCT FROM v_source->>'reason' OR photo_path IS DISTINCT FROM coalesce(v_item.photo_path,''));
    RETURN false;
  END IF;
  INSERT INTO eeum_photo_ai.jobs(item_id,photo_path,source_version,state)
  VALUES (v_item.id,v_item.photo_path,v_source->>'version','pending')
  ON CONFLICT(item_id) DO UPDATE SET photo_path=EXCLUDED.photo_path,source_version=EXCLUDED.source_version,
    state='pending',attempts=0,next_try_at=now(),lease_id=NULL,claimed_at=NULL,last_error=NULL,
    updated_at=now()
  WHERE eeum_photo_ai.jobs.source_version IS DISTINCT FROM EXCLUDED.source_version
     OR eeum_photo_ai.jobs.photo_path IS DISTINCT FROM EXCLUDED.photo_path
     OR eeum_photo_ai.jobs.state='cancelled';
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed>0;
END $$;

CREATE FUNCTION eeum_photo_ai.items_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM eeum_photo_ai.enqueue(NEW.id); RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 큐 오류로 기존 수집/담당자 변경을 롤백하지 않습니다. 등록 누락 경고는 관리자 점검이 필요합니다.
  RAISE WARNING 'photo_ai_enqueue_failed';
  RETURN NEW;
END $$;
CREATE TRIGGER trg_eeum_photo_ai_items AFTER INSERT OR UPDATE OF photo_path,status,created_by
ON public.items FOR EACH ROW EXECUTE FUNCTION eeum_photo_ai.items_changed();

-- 수동 백필 전용. 원본 및 같은 버전의 완료/실패/처리 중 상태를 초기화하지 않습니다.
CREATE FUNCTION public.eeum_photo_ai_backfill(p_after_id text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id text; v_count integer:=0; v_queued integer:=0; v_last text:=p_after_id;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid_batch_limit'; END IF;
  FOR v_id IN SELECT i.id FROM public.items i WHERE i.created_by IS NULL AND i.status<>'수령완료'
    AND (i.id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR i.id ~ '^[PFB][0-9]{13,}$')
    AND (p_after_id IS NULL OR i.id>p_after_id) ORDER BY i.id LIMIT p_limit FOR UPDATE OF i SKIP LOCKED
  LOOP
    v_count:=v_count+1; v_last:=v_id;
    IF eeum_photo_ai.enqueue(v_id) THEN v_queued:=v_queued+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('scanned',v_count,'queued',v_queued,'after_id',v_last,'has_more',v_count=p_limit);
END $$;

CREATE FUNCTION public.eeum_photo_ai_configure(p_mode text,p_item_id text DEFAULT NULL,p_daily_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_control eeum_photo_ai.control%ROWTYPE; v_item public.items%ROWTYPE; v_source jsonb;
BEGIN
  IF p_mode NOT IN ('off','pilot','new','all') OR p_daily_limit NOT BETWEEN 1 AND 1440 THEN RAISE EXCEPTION 'invalid_configuration'; END IF;
  SELECT * INTO v_control FROM eeum_photo_ai.control WHERE singleton FOR UPDATE;
  IF p_mode<>'off' AND v_control.active_until>clock_timestamp() THEN RAISE EXCEPTION 'worker_still_running'; END IF;
  IF p_mode='pilot' THEN
    SELECT * INTO v_item FROM public.items WHERE id=p_item_id FOR UPDATE;
    IF NOT FOUND OR v_item.created_by IS NOT NULL OR v_item.status='수령완료' OR
      NOT (v_item.id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR v_item.id ~ '^[PFB][0-9]{13,}$') THEN
      RAISE EXCEPTION 'invalid_pilot_item';
    END IF;
    v_source:=eeum_photo_ai.source(v_item.id,v_item.photo_path);
    IF NOT (v_source->>'eligible')::boolean THEN RAISE EXCEPTION 'pilot_photo_not_eligible'; END IF;
    PERFORM eeum_photo_ai.enqueue(p_item_id);
  END IF;
  IF p_mode IN ('new','all') THEN
    SELECT * INTO v_item FROM public.items WHERE id=v_control.pilot_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'successful_pilot_required'; END IF;
    v_source:=eeum_photo_ai.source(v_item.id,v_item.photo_path);
    IF v_item.created_by IS NOT NULL OR v_item.status='수령완료' OR NOT (v_source->>'eligible')::boolean OR NOT EXISTS (
      SELECT 1 FROM eeum_photo_ai.jobs q WHERE q.item_id=v_item.id AND q.state='review'
        AND q.source_version=v_source->>'version' AND q.result_source_version=v_source->>'version'
    ) THEN RAISE EXCEPTION 'successful_pilot_required'; END IF;
  END IF;
  UPDATE eeum_photo_ai.control SET mode=p_mode,pilot_item_id=CASE WHEN p_mode='pilot' THEN p_item_id ELSE pilot_item_id END,
    daily_limit=p_daily_limit,pause_reason=NULL WHERE singleton;
  RETURN jsonb_build_object('mode',p_mode,'pilot_item_id',CASE WHEN p_mode='pilot' THEN p_item_id ELSE v_control.pilot_item_id END,'daily_limit',p_daily_limit);
END $$;

CREATE FUNCTION public.eeum_photo_ai_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object('mode',c.mode,'pilot_item_id',c.pilot_item_id,'pause_reason',c.pause_reason,
    'daily_limit',c.daily_limit,'daily_starts',c.daily_starts,'daily_date',c.daily_date,
    'active',coalesce(c.active_until>clock_timestamp(),false),'next_start_at',c.next_start_at,
    'counts',(SELECT coalesce(jsonb_object_agg(q.state,q.n),'{}'::jsonb)
      FROM (SELECT state,count(*) AS n FROM eeum_photo_ai.jobs GROUP BY state) q))
  FROM eeum_photo_ai.control c WHERE singleton;
$$;

CREATE FUNCTION public.eeum_photo_ai_claim(p_item_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c eeum_photo_ai.control%ROWTYPE; j eeum_photo_ai.jobs%ROWTYPE;
  v_id text; v_expired text; v_scan jsonb; v_source jsonb; v_lease uuid;
  v_scanned integer:=0; v_last text;
BEGIN
  SELECT * INTO c FROM eeum_photo_ai.control WHERE singleton FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('job',NULL,'reason','busy'); END IF;
  IF c.mode='off' OR c.pause_reason IS NOT NULL THEN RETURN jsonb_build_object('job',NULL,'reason','disabled_or_paused'); END IF;
  IF c.mode='pilot' AND p_item_id IS DISTINCT FROM c.pilot_item_id THEN RETURN jsonb_build_object('job',NULL,'reason','pilot_target_required'); END IF;
  IF c.active_until>clock_timestamp() THEN RETURN jsonb_build_object('job',NULL,'reason','busy'); END IF;
  IF c.active_lease IS NOT NULL THEN
    SELECT item_id INTO v_expired FROM eeum_photo_ai.jobs WHERE lease_id=c.active_lease;
    IF v_expired IS NOT NULL THEN
      PERFORM 1 FROM public.items WHERE id=v_expired FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN RETURN jsonb_build_object('job',NULL,'reason','busy'); END IF;
      UPDATE eeum_photo_ai.jobs SET state=CASE WHEN attempts<3 THEN 'retry' ELSE 'failed' END,
        next_try_at=CASE WHEN attempts<3 THEN now()+CASE WHEN attempts=1 THEN interval '5 minutes' ELSE interval '15 minutes' END ELSE NULL END,
        last_error='lease_expired',lease_id=NULL,claimed_at=NULL,updated_at=now() WHERE lease_id=c.active_lease;
    END IF;
    UPDATE eeum_photo_ai.control SET active_lease=NULL,active_until=NULL WHERE singleton;
  END IF;
  IF c.daily_date<>(now() AT TIME ZONE 'Asia/Seoul')::date THEN
    c.daily_starts:=0;
    UPDATE eeum_photo_ai.control SET daily_date=(now() AT TIME ZONE 'Asia/Seoul')::date,daily_starts=0 WHERE singleton;
  END IF;
  IF c.next_start_at>clock_timestamp() THEN RETURN jsonb_build_object('job',NULL,'reason','minute_limit'); END IF;
  IF c.daily_starts>=c.daily_limit THEN RETURN jsonb_build_object('job',NULL,'reason','daily_limit'); END IF;
  IF c.mode='pilot' THEN
    PERFORM eeum_photo_ai.enqueue(c.pilot_item_id);
  ELSIF c.mode='new' THEN
    -- 신규 유입 트리거가 등록한 작업만 대조합니다. 기존 사진 전체를 백필하지 않습니다.
    FOR v_id IN SELECT i.id FROM public.items i JOIN eeum_photo_ai.jobs q ON q.item_id=i.id
      WHERE c.reconcile_after IS NULL OR i.id>c.reconcile_after
      ORDER BY i.id LIMIT 200 FOR UPDATE OF i SKIP LOCKED
    LOOP
      v_scanned:=v_scanned+1; v_last:=v_id;
      PERFORM eeum_photo_ai.enqueue(v_id);
    END LOOP;
    UPDATE eeum_photo_ai.control SET reconcile_after=CASE WHEN v_scanned=200 THEN v_last ELSE NULL END WHERE singleton;
  ELSE
    v_scan:=public.eeum_photo_ai_backfill(c.reconcile_after,200);
    UPDATE eeum_photo_ai.control SET reconcile_after=CASE WHEN (v_scan->>'has_more')::boolean THEN v_scan->>'after_id' ELSE NULL END WHERE singleton;
  END IF;
  v_id:=NULL;
  SELECT i.id INTO v_id FROM public.items i JOIN eeum_photo_ai.jobs q ON q.item_id=i.id
    WHERE q.state IN ('pending','retry') AND q.attempts<3 AND q.next_try_at<=clock_timestamp()
      AND (c.mode<>'pilot' OR q.item_id=c.pilot_item_id) AND (p_item_id IS NULL OR q.item_id=p_item_id)
    ORDER BY q.next_try_at,q.item_id LIMIT 1 FOR UPDATE OF i SKIP LOCKED;
  IF v_id IS NULL THEN RETURN jsonb_build_object('job',NULL,'reason','no_due_jobs'); END IF;
  PERFORM eeum_photo_ai.enqueue(v_id);
  SELECT * INTO j FROM eeum_photo_ai.jobs WHERE item_id=v_id FOR UPDATE;
  IF j.state NOT IN ('pending','retry') THEN RETURN jsonb_build_object('job',NULL,'reason','source_not_eligible'); END IF;
  SELECT eeum_photo_ai.source(i.id,i.photo_path) INTO v_source FROM public.items i WHERE i.id=v_id;
  v_lease:=gen_random_uuid();
  UPDATE eeum_photo_ai.jobs SET state='processing',attempts=attempts+1,lease_id=v_lease,claimed_at=clock_timestamp(),next_try_at=NULL,updated_at=now() WHERE item_id=v_id;
  UPDATE eeum_photo_ai.control SET active_lease=v_lease,active_until=clock_timestamp()+interval '2 minutes',
    next_start_at=clock_timestamp()+interval '1 minute',daily_starts=daily_starts+1 WHERE singleton;
  RETURN jsonb_build_object('job',jsonb_build_object('item_id',j.item_id,'photo_path',j.photo_path,
    'source_version',j.source_version,'lease_id',v_lease,'expected_bytes',(v_source->>'bytes')::integer,
    'expected_mime',v_source->>'mime'));
END $$;

CREATE FUNCTION public.eeum_photo_ai_finish(p_item_id text,p_lease_id uuid,p_source_version text,
  p_action text,p_result jsonb DEFAULT NULL,p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c eeum_photo_ai.control%ROWTYPE; j eeum_photo_ai.jobs%ROWTYPE;
  v_item public.items%ROWTYPE; v_source jsonb; v_result jsonb; v_reason text;
BEGIN
  SELECT * INTO c FROM eeum_photo_ai.control WHERE singleton FOR UPDATE;
  SELECT * INTO v_item FROM public.items WHERE id=p_item_id FOR UPDATE;
  SELECT * INTO j FROM eeum_photo_ai.jobs WHERE item_id=p_item_id FOR UPDATE;
  IF j.last_finished_lease=p_lease_id AND j.last_finished_action=p_action AND j.source_version=p_source_version
    AND j.state IN ('review','retry','failed','skipped') THEN
    RETURN jsonb_build_object('committed',true,'state',j.state,'replayed',true);
  END IF;
  IF j.item_id IS NULL OR j.state<>'processing' OR j.lease_id IS DISTINCT FROM p_lease_id
    OR j.source_version IS DISTINCT FROM p_source_version OR c.active_lease IS DISTINCT FROM p_lease_id THEN
    UPDATE eeum_photo_ai.control SET active_lease=NULL,active_until=NULL WHERE singleton AND active_lease=p_lease_id;
    RETURN jsonb_build_object('committed',false,'state','superseded');
  END IF;
  v_source:=eeum_photo_ai.source(v_item.id,v_item.photo_path);
  IF v_item.created_by IS NOT NULL OR v_item.status='수령완료' OR NOT (v_source->>'eligible')::boolean
    OR v_source->>'version' IS DISTINCT FROM p_source_version THEN
    PERFORM eeum_photo_ai.enqueue(p_item_id);
    UPDATE eeum_photo_ai.control SET active_lease=NULL,active_until=NULL WHERE singleton AND active_lease=p_lease_id;
    RETURN jsonb_build_object('committed',false,'state','source_changed');
  END IF;
  v_reason:=CASE WHEN p_reason ~ '^[a-z][a-z0-9_]{0,63}$' THEN p_reason ELSE 'worker_failed' END;
  IF p_action='succeeded' THEN
    IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR p_result->>'parser_version' IS DISTINCT FROM 'eeum-photo-v1'
      OR jsonb_typeof(p_result->'privacy') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_result->'materials') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_result->'shapes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_result->'photo_features') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'invalid_photo_result'; END IF;
    IF (p_result->>'color' IS NOT NULL AND p_result->>'color' NOT IN ('검정','흰색','남색','파랑','빨강','회색','갈색','분홍','베이지'))
      OR jsonb_array_length(p_result->'materials')>3 OR jsonb_array_length(p_result->'shapes')>4
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_result->'materials') v WHERE v IS NULL OR v NOT IN ('가죽','인조가죽','천','플라스틱','금속','고무','실리콘','유리','종이','나무'))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_result->'shapes') v WHERE v IS NULL OR v NOT IN ('퀼팅','꽃 장식','리본','지퍼','손잡이','키링','카메라 렌즈','줄무늬','체크무늬','격자무늬','도트무늬','하트무늬','스티커','금속 장식','투명','불투명','무광','유광','로고','자수','단추')) THEN
      RAISE EXCEPTION 'invalid_photo_tags';
    END IF;
    IF jsonb_array_length(p_result->'photo_features')>4
      OR ((p_result->>'privacy')::boolean AND jsonb_array_length(p_result->'photo_features')>0)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_result->'photo_features') v
        WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 80
          OR (v#>>'{}') ~ '[[:cntrl:]<>]'
          OR (v#>>'{}') ~* '성명|이름|주소|생년|연락처|전화|주민|면허|여권|계좌|카드번호|얼굴|인물|여성|남성|남자|여자|어린이|개인정보|[0-9]{4}|@|https?://') THEN
      RAISE EXCEPTION 'invalid_private_photo_features';
    END IF;
    v_result:=jsonb_build_object('parser_version','eeum-photo-v1','color',p_result->'color','materials',p_result->'materials','shapes',p_result->'shapes',
      'photo_features',p_result->'photo_features','privacy',p_result->'privacy');
    UPDATE eeum_photo_ai.jobs SET state='review',result=v_result,result_source_version=p_source_version,
      last_error=NULL,next_try_at=NULL,lease_id=NULL,claimed_at=NULL,updated_at=now() WHERE item_id=p_item_id;
  ELSIF p_action IN ('retry','failed','skipped','paused') THEN
    UPDATE eeum_photo_ai.jobs SET state=CASE WHEN p_action IN ('retry','paused') AND attempts<3 THEN 'retry'
      WHEN p_action='skipped' THEN 'skipped' ELSE 'failed' END,
      next_try_at=CASE WHEN p_action IN ('retry','paused') AND attempts<3 THEN now()+CASE WHEN attempts=1 THEN interval '5 minutes' ELSE interval '15 minutes' END ELSE NULL END,
      lease_id=NULL,claimed_at=NULL,last_error=v_reason,updated_at=now() WHERE item_id=p_item_id;
    IF p_action='paused' THEN UPDATE eeum_photo_ai.control SET pause_reason=v_reason WHERE singleton; END IF;
  ELSE RAISE EXCEPTION 'invalid_finish_action'; END IF;
  UPDATE eeum_photo_ai.jobs SET last_finished_lease=p_lease_id,last_finished_action=p_action WHERE item_id=p_item_id;
  UPDATE eeum_photo_ai.control SET active_lease=NULL,active_until=NULL WHERE singleton AND active_lease=p_lease_id;
  RETURN jsonb_build_object('committed',true,'state',(SELECT state FROM eeum_photo_ai.jobs WHERE item_id=p_item_id));
END $$;

-- 담당자 화면은 소속 기관 물품의 현재 사진에 대한 비공개 제안만 읽습니다.
CREATE FUNCTION public.eeum_photo_ai_get(p_item_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item public.items%ROWTYPE; j eeum_photo_ai.jobs%ROWTYPE; v_source jsonb;
BEGIN
  SELECT i.* INTO v_item FROM public.items i WHERE i.id=p_item_id AND EXISTS (
    SELECT 1 FROM public.staff_members s WHERE s.user_id=auth.uid() AND s.org_id=i.org_id
  );
  IF NOT FOUND THEN RAISE EXCEPTION 'staff_item_access_required' USING ERRCODE='42501'; END IF;
  SELECT * INTO j FROM eeum_photo_ai.jobs WHERE item_id=p_item_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_source:=eeum_photo_ai.source(v_item.id,v_item.photo_path);
  IF v_item.created_by IS NULL AND v_item.status<>'수령완료' AND (v_source->>'eligible')::boolean
    AND j.state='review' AND j.source_version=v_source->>'version'
    AND j.result_source_version=v_source->>'version' THEN
    RETURN jsonb_build_object('managed',true,'available',true,'state',j.state,'result',j.result);
  END IF;
  RETURN jsonb_build_object('managed',true,'available',false,'state',j.state);
END $$;
REVOKE ALL ON FUNCTION public.eeum_photo_ai_get(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.eeum_photo_ai_get(text) TO authenticated;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eeum_photo_ai FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.eeum_photo_ai_backfill(text,integer),public.eeum_photo_ai_configure(text,text,integer),
  public.eeum_photo_ai_status(),public.eeum_photo_ai_claim(text),public.eeum_photo_ai_finish(text,uuid,text,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.eeum_photo_ai_status(),public.eeum_photo_ai_claim(text),
  public.eeum_photo_ai_finish(text,uuid,text,text,jsonb,text) TO service_role;
COMMIT;
-- 고현 수정 끝: 비공개 사진 분석 큐
