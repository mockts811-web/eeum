-- 고현 수정 시작: 기존·신규 사진 분석 결과를 공개 특징에 자동 추가하고 변경 전 설명 보관
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM eeum_photo_ai.control WHERE singleton AND mode='off'
    AND coalesce(active_until<=clock_timestamp(),true)) THEN RAISE EXCEPTION 'pause_and_wait_first'; END IF;
  IF to_regclass('eeum_photo_ai.publications') IS NOT NULL THEN RAISE EXCEPTION 'public_features_already_installed'; END IF;
END $$;
ALTER TABLE eeum_photo_ai.control ADD COLUMN publish_public boolean NOT NULL DEFAULT false;
SET LOCAL timezone='UTC';
CREATE OR REPLACE FUNCTION eeum_photo_ai.source(p_id text, p_path text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path='' SET timezone='UTC' AS $$
DECLARE v_path text; v_base text; v_object jsonb; v_size numeric; v_mime text; v_etag text;
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
  -- 수집기의 같은 사진 upsert가 객체 version을 바꾸더라도 내용 ETag가 같으면 재분석하지 않습니다.
  v_etag:=lower(btrim(v_object#>>'{metadata,eTag}','"'));
  IF v_etag ~ '^[a-f0-9]{32}(-[0-9]{1,5})?$' THEN
    RETURN jsonb_build_object('eligible',true,'path',v_path,
      'version',md5(concat_ws('|','eeum-photo-v1',v_path,'etag:'||v_etag,v_size::text,v_mime)),
      'bytes',v_size,'mime',v_mime);
  END IF;
  RETURN jsonb_build_object('eligible',true,'path',v_path,
    'version',md5(concat_ws('|','eeum-photo-v1',v_path,v_object->>'id',v_object->>'version',v_object->>'updated_at',v_size::text,v_mime)),
    'bytes',v_size,'mime',v_mime);
END $$;


-- 현재 객체와 일치하는 기존 완료 결과의 버전 표기만 전환합니다. 상태/시도 횟수는 초기화하지 않습니다.
UPDATE eeum_photo_ai.jobs j SET source_version=s.source->>'version',
  result_source_version=CASE WHEN j.result_source_version=j.source_version THEN s.source->>'version' ELSE j.result_source_version END
FROM public.items i CROSS JOIN LATERAL (SELECT eeum_photo_ai.source(i.id,i.photo_path) AS source) s
JOIN storage.objects o ON o.bucket_id='item-photos' AND o.name=s.source->>'path'
WHERE j.item_id=i.id AND j.state<>'processing' AND (s.source->>'eligible')::boolean
  AND j.source_version=md5(concat_ws('|','eeum-photo-v1',o.name,o.id::text,o.version,to_jsonb(o)->>'updated_at',
    CASE WHEN o.metadata->>'size' ~ '^[0-9]{1,12}$' THEN (o.metadata->>'size')::numeric::text ELSE '' END,lower(o.metadata->>'mimetype')))
  AND j.source_version IS DISTINCT FROM s.source->>'version';

CREATE TABLE eeum_photo_ai.publications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id text NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  source_version text NOT NULL,
  previous_description text,
  published_description text NOT NULL,
  added_features jsonb NOT NULL CHECK (jsonb_typeof(added_features)='array'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rolled_back_at timestamptz,
  UNIQUE(item_id,source_version)
);
ALTER TABLE eeum_photo_ai.publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON eeum_photo_ai.publications FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE eeum_photo_ai.publications_id_seq FROM PUBLIC,anon,authenticated,service_role;

-- 자유형 이름·번호·지시문은 공개하지 않습니다. 사전의 외형 어휘로만 이루어진 제안만 허용합니다.
-- 이 어휘표는 내부 공개 필터이며 공식 기관 코드표 또는 사진 사실 검증을 의미하지 않습니다.
CREATE FUNCTION eeum_photo_ai.public_features(p_result jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v text; v_rest text; v_pattern text; v_values jsonb; v_out text[]:='{}';
BEGIN
  IF p_result->'privacy' IS DISTINCT FROM 'false'::jsonb
    OR p_result->>'parser_version' IS DISTINCT FROM 'eeum-photo-v1' THEN RETURN v_out; END IF;
  SELECT '('||string_agg(t,'|' ORDER BY length(t) DESC,t)||')' INTO v_pattern FROM unnest(ARRAY[
    '검정','검정색','검은색','검은','흰색','하얀색','하얀','남색','네이비','파랑','파란색','파란','빨강','빨간색','빨간',
    '회색','갈색','분홍','분홍색','베이지','보라','보라색','노랑','노란색','노란','초록','초록색','녹색','연두','연두색',
    '주황','주황색','금색','은색','금빛','은빛','청록색','하늘색','아이보리','크림색','연한','진한','짙은',
    '가죽','인조가죽','합성피혁','천','플라스틱','금속','고무','실리콘','유리','종이','나무','패브릭','캔버스',
    '나일론','폴리에스터','비닐','스테인리스','알루미늄','면','털','재질','소재','표면','느낌',
    '퀼팅','꽃 장식','꽃','꽃무늬','리본','지퍼','손잡이','키링','카메라 렌즈','카메라','렌즈','줄무늬',
    '체크무늬','체크','격자무늬','격자','도트무늬','도트','하트무늬','하트','별무늬','물방울','스티커',
    '금속 장식','장식','투명','불투명','무광','유광','광택','로고','자수','단추','무늬','패턴',
    '사피아노','샤피아노','양각','음각','엠보싱','다이아몬드','버클','스냅','벨크로','찍찍이',
    '덮개형','덮개','플랩','버튼형','버튼','고리','열쇠고리','체인','스트랩','어깨끈','손목끈','끈',
    '구부러진','곡선형','일자형','접이식','접힌','긴','짧은','두꺼운','얇은','작은','큰','둥근형','둥근',
    '모서리','원형','타원형','반원형','정사각형','직사각형','사각형','삼각형','원통형','봉투형',
    '장지갑','반지갑','카드지갑','지퍼형','단우산','장우산','테두리','배색','단색','투톤','멀티컬러',
    '매끈한','거친','짜임','그물','망사','캡','팁','우산살','몸체','커버','케이스','돌출형','바퀴',
    '포켓','주머니','수납칸','접힘','주름','낡은','마모','벗겨진','스크래치','흠집','오염','찢어짐','찢어진','훼손','의','및'
  ]) AS t;
  v_values:=CASE WHEN jsonb_typeof(p_result->'photo_features')='array' THEN p_result->'photo_features' ELSE '[]'::jsonb END;
  v_values:=v_values||CASE WHEN jsonb_typeof(p_result->'materials')='array' THEN p_result->'materials' ELSE '[]'::jsonb END
    ||CASE WHEN jsonb_typeof(p_result->'shapes')='array' THEN p_result->'shapes' ELSE '[]'::jsonb END;
  IF p_result->>'color'=ANY(ARRAY['검정','흰색','남색','파랑','빨강','회색','갈색','분홍','베이지']) THEN
    v_values:=v_values||jsonb_build_array(p_result->>'color');
  END IF;
  FOR v IN SELECT value#>>'{}' FROM jsonb_array_elements(v_values) WITH ORDINALITY a(value,n)
    WHERE jsonb_typeof(value)='string' ORDER BY n LIMIT 16
  LOOP
    v:=btrim(regexp_replace(v,'[[:space:]]+',' ','g'));
    IF length(v) NOT BETWEEN 1 AND 80 OR v ~ '[[:cntrl:]A-Za-z0-9@<>]'
      OR v ~ '성명|이름|주소|생년|연락처|전화|주민|면허|여권|계좌|카드번호|얼굴|인물|개인정보' THEN CONTINUE; END IF;
    v_rest:=regexp_replace(regexp_replace(v,v_pattern,'','g'),'[[:space:]·,()/.-]','','g');
    IF v_rest='' AND NOT v=ANY(v_out) THEN v_out:=array_append(v_out,v); END IF;
    EXIT WHEN cardinality(v_out)>=8;
  END LOOP;
  RETURN v_out;
END $$;

CREATE FUNCTION eeum_photo_ai.publish(p_item_id text) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c eeum_photo_ai.control%ROWTYPE; j eeum_photo_ai.jobs%ROWTYPE;
  i public.items%ROWTYPE; v_source jsonb; v text; v_before text; v_after text;
  v_compact text; v_added text[]:='{}';
BEGIN
  SELECT * INTO c FROM eeum_photo_ai.control WHERE singleton;
  IF NOT c.publish_public OR c.mode='off' OR c.pause_reason IS NOT NULL
    OR (c.mode='pilot' AND p_item_id IS DISTINCT FROM c.pilot_item_id) THEN
    RETURN jsonb_build_object('published',false,'reason','publication_disabled');
  END IF;
  SELECT * INTO i FROM public.items WHERE id=p_item_id FOR UPDATE;
  SELECT * INTO j FROM eeum_photo_ai.jobs WHERE item_id=p_item_id;
  IF i.id IS NULL OR i.created_by IS NOT NULL OR i.status='수령완료' OR j.state IS DISTINCT FROM 'review'
    OR NOT (i.id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR i.id ~ '^[PFB][0-9]{13,}$') THEN
    RETURN jsonb_build_object('published',false,'reason','item_not_eligible');
  END IF;
  v_source:=eeum_photo_ai.source(i.id,i.photo_path);
  IF NOT (v_source->>'eligible')::boolean OR j.source_version IS DISTINCT FROM v_source->>'version'
    OR j.result_source_version IS DISTINCT FROM v_source->>'version' THEN
    RETURN jsonb_build_object('published',false,'reason','source_changed');
  END IF;
  IF EXISTS(SELECT 1 FROM eeum_photo_ai.publications p WHERE p.item_id=i.id AND p.source_version=j.source_version) THEN
    RETURN jsonb_build_object('published',false,'reason','already_processed');
  END IF;
  v_before:=i.description;
  v_compact:=regexp_replace(lower(coalesce(v_before,'')),'[[:space:]]','','g');
  FOREACH v IN ARRAY eeum_photo_ai.public_features(j.result)
  LOOP
    IF position(regexp_replace(lower(v),'[[:space:]]','','g') IN v_compact)>0 OR v=ANY(v_added) THEN CONTINUE; END IF;
    v_added:=array_append(v_added,v);
    EXIT WHEN cardinality(v_added)=4;
  END LOOP;
  IF cardinality(v_added)=0 THEN RETURN jsonb_build_object('published',false,'reason','no_new_public_features'); END IF;
  v_after:=coalesce(v_before,'')||CASE WHEN coalesce(v_before,'')='' THEN ''
    WHEN v_before ~ '[.。!?][[:space:]]*$' THEN ' ' ELSE ', ' END||array_to_string(v_added,', ');
  IF length(v_after)>1200 THEN RETURN jsonb_build_object('published',false,'reason','description_too_long'); END IF;
  INSERT INTO eeum_photo_ai.publications(item_id,source_version,previous_description,published_description,added_features)
    VALUES(i.id,j.source_version,v_before,v_after,to_jsonb(v_added));
  UPDATE public.items SET description=v_after WHERE id=i.id;
  UPDATE eeum_photo_ai.jobs SET last_error=NULL WHERE item_id=i.id AND last_error='public_feature_publish_failed';
  RETURN jsonb_build_object('published',true,'added',cardinality(v_added));
EXCEPTION WHEN OTHERS THEN
  -- 결과 저장은 유지하고 다음 대조 때 공개 저장만 재시도합니다. Gemini를 다시 부르지 않습니다.
  UPDATE eeum_photo_ai.jobs SET last_error='public_feature_publish_failed' WHERE item_id=p_item_id AND state='review';
  RETURN jsonb_build_object('published',false,'reason','public_feature_publish_failed');
END $$;

CREATE FUNCTION public.eeum_photo_ai_restore_public() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c eeum_photo_ai.control%ROWTYPE; p eeum_photo_ai.publications%ROWTYPE; v_changed integer;
  v_restored integer:=0; v_skipped integer:=0;
BEGIN
  SELECT * INTO c FROM eeum_photo_ai.control WHERE singleton FOR UPDATE;
  IF c.mode<>'off' OR c.active_until>clock_timestamp() THEN RAISE EXCEPTION 'pause_and_wait_first'; END IF;
  UPDATE eeum_photo_ai.control SET publish_public=false WHERE singleton;
  FOR p IN SELECT * FROM eeum_photo_ai.publications WHERE rolled_back_at IS NULL ORDER BY id DESC
  LOOP
    UPDATE public.items SET description=p.previous_description
      WHERE id=p.item_id AND description IS NOT DISTINCT FROM p.published_description;
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed=1 THEN
      UPDATE eeum_photo_ai.publications SET rolled_back_at=clock_timestamp() WHERE id=p.id;
      v_restored:=v_restored+1;
    ELSE v_skipped:=v_skipped+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('restored',v_restored,'skipped_staff_changes',v_skipped);
END $$;
REVOKE ALL ON FUNCTION public.eeum_photo_ai_restore_public() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION eeum_photo_ai.enqueue(p_item_id text) RETURNS boolean
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
  PERFORM eeum_photo_ai.publish(p_item_id);
  RETURN v_changed>0;
END $$;


CREATE OR REPLACE FUNCTION public.eeum_photo_ai_finish(p_item_id text,p_lease_id uuid,p_source_version text,
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
  IF p_action='succeeded' THEN PERFORM eeum_photo_ai.publish(p_item_id); END IF;
  UPDATE eeum_photo_ai.jobs SET last_finished_lease=p_lease_id,last_finished_action=p_action WHERE item_id=p_item_id;
  UPDATE eeum_photo_ai.control SET active_lease=NULL,active_until=NULL WHERE singleton AND active_lease=p_lease_id;
  RETURN jsonb_build_object('committed',true,'state',(SELECT state FROM eeum_photo_ai.jobs WHERE item_id=p_item_id));
END $$;


CREATE OR REPLACE FUNCTION public.eeum_photo_ai_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object('mode',c.mode,'pilot_item_id',c.pilot_item_id,'pause_reason',c.pause_reason,
    'publish_public',c.publish_public,'published',(SELECT count(*) FROM eeum_photo_ai.publications WHERE rolled_back_at IS NULL),
    'daily_limit',c.daily_limit,'daily_starts',c.daily_starts,'daily_date',c.daily_date,
    'active',coalesce(c.active_until>clock_timestamp(),false),'next_start_at',c.next_start_at,
    'counts',(SELECT coalesce(jsonb_object_agg(q.state,q.n),'{}'::jsonb)
      FROM (SELECT state,count(*) AS n FROM eeum_photo_ai.jobs GROUP BY state) q))
  FROM eeum_photo_ai.control c WHERE singleton;
$$;


REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eeum_photo_ai FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
-- 고현 수정 끝: 기존·신규 사진 분석 결과를 공개 특징에 자동 추가하고 변경 전 설명 보관
