-- 고현 수정 시작: 공개 특징 상투 문구 정리. AI 재호출 없이 원문을 비공개 이력에 보관합니다.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE eeum_photo_ai.description_formats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id text NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  previous_description text NOT NULL,
  formatted_description text NOT NULL,
  formatted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rolled_back_at timestamptz
);
CREATE INDEX description_formats_item_idx ON eeum_photo_ai.description_formats(item_id);
ALTER TABLE eeum_photo_ai.description_formats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON eeum_photo_ai.description_formats FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE eeum_photo_ai.description_formats_id_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION eeum_photo_ai.tidy_description(p_text text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v text;
BEGIN
  IF p_text IS NULL THEN RETURN NULL; END IF;
  -- 문장 끝/구분자까지 확인해 일부 어구만 잘못 잘라내지 않습니다.
  v:=regexp_replace(p_text,
    '[을를]?[[:space:]]*습득(하여|하고|해|한[[:space:]]*후|[[:space:]]*후)?[[:space:]]*보관[[:space:]]*(하고[[:space:]]*있습니다|하고[[:space:]]*있음|중입니다|중이며|중임|중)([[:space:]]*[.。]|[[:space:]]*[,·]|[[:space:]]*$)',
    ', ','g');
  IF v IS NOT DISTINCT FROM p_text THEN RETURN p_text; END IF;
  v:=regexp_replace(v,',[[:space:]]*,+',', ','g');
  v:=regexp_replace(v,'[[:space:]]+',' ','g');
  RETURN regexp_replace(v,'^[[:space:],]+|[[:space:],]+$','','g');
END $$;

CREATE FUNCTION eeum_photo_ai.tidy_item(p_item_id text) RETURNS boolean
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c eeum_photo_ai.control%ROWTYPE; i public.items%ROWTYPE; v_after text;
BEGIN
  SELECT * INTO c FROM eeum_photo_ai.control WHERE singleton;
  IF NOT c.publish_public OR c.mode='off' OR c.pause_reason IS NOT NULL
    OR (c.mode='pilot' AND p_item_id IS DISTINCT FROM c.pilot_item_id) THEN RETURN false; END IF;
  SELECT * INTO i FROM public.items WHERE id=p_item_id FOR UPDATE;
  IF NOT FOUND OR i.created_by IS NOT NULL OR i.status='수령완료'
    OR NOT (i.id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR i.id ~ '^[PFB][0-9]{13,}$') THEN RETURN false; END IF;
  v_after:=eeum_photo_ai.tidy_description(i.description);
  IF coalesce(v_after,'')='' OR v_after IS NOT DISTINCT FROM i.description THEN RETURN false; END IF;
  INSERT INTO eeum_photo_ai.description_formats(item_id,previous_description,formatted_description)
    VALUES(i.id,i.description,v_after);
  UPDATE public.items SET description=v_after WHERE id=i.id;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'photo_ai_description_format_failed';
  RETURN false;
END $$;

-- 사진 보강과 문장 정리 이력을 함께 최신순으로 복구합니다. 담당자의 후속 수정은 건너뜁니다.
CREATE OR REPLACE FUNCTION public.eeum_photo_ai_restore_public() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c eeum_photo_ai.control%ROWTYPE; r record; v_changed integer;
  v_restored integer:=0; v_skipped integer:=0;
BEGIN
  SELECT * INTO c FROM eeum_photo_ai.control WHERE singleton FOR UPDATE;
  IF c.mode<>'off' OR c.active_until>clock_timestamp() THEN RAISE EXCEPTION 'pause_and_wait_first'; END IF;
  UPDATE eeum_photo_ai.control SET publish_public=false WHERE singleton;
  FOR r IN
    SELECT 'photo' AS kind,id,item_id,previous_description,published_description AS after_description,published_at AS happened_at
      FROM eeum_photo_ai.publications WHERE rolled_back_at IS NULL
    UNION ALL
    SELECT 'format',id,item_id,previous_description,formatted_description,formatted_at
      FROM eeum_photo_ai.description_formats WHERE rolled_back_at IS NULL
    ORDER BY happened_at DESC,kind,id DESC
  LOOP
    UPDATE public.items SET description=r.previous_description
      WHERE id=r.item_id AND description IS NOT DISTINCT FROM r.after_description;
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed=1 THEN
      IF r.kind='photo' THEN UPDATE eeum_photo_ai.publications SET rolled_back_at=clock_timestamp() WHERE id=r.id;
      ELSE UPDATE eeum_photo_ai.description_formats SET rolled_back_at=clock_timestamp() WHERE id=r.id; END IF;
      v_restored:=v_restored+1;
    ELSE v_skipped:=v_skipped+1; END IF;
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
  PERFORM eeum_photo_ai.tidy_item(p_item_id);
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



CREATE OR REPLACE FUNCTION eeum_photo_ai.publish(p_item_id text) RETURNS jsonb
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
  PERFORM eeum_photo_ai.tidy_item(p_item_id);
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


REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eeum_photo_ai FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
-- 고현 수정 끝: 공개 특징 상투 문구 정리와 원문 보관
