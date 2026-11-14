<!-- 고현 수정 시작: 비밀값과 개별 운영 행을 제외한 검증 근거 -->

**공개 API/객체 HEAD 관측 결과**

```json
{
  "observed_at_utc": "2026-11-14T11:20:41.069940+00:00",
  "source": "feature/dugong CONFIG (public publishable key)",
  "host": "https://xhvthvxpwlaecizqlrrv.supabase.co",
  "requests": [
    {
      "path": "/rest/v1/",
      "method": "GET",
      "status": 401,
      "code": null
    },
    {
      "path": "/rest/v1/items?select=id",
      "method": "HEAD",
      "status": 200,
      "content_range": "0-977/978"
    },
    {
      "path": "/rest/v1/item_private?select=item_id&limit=0",
      "method": "GET",
      "status": 401,
      "code": "42501"
    },
    {
      "path": "/rest/v1/staff_members?select=user_id&limit=0",
      "method": "GET",
      "status": 401,
      "code": "42501"
    },
    {
      "path": "/rest/v1/items?select=ai_photo_status&limit=0",
      "method": "GET",
      "status": 400,
      "code": "42703",
      "message": "column items.ai_photo_status does not exist"
    },
    {
      "path": "/rest/v1/orgs?select=id,name,kind,tel,hours,lines,delivery&limit=0",
      "method": "GET",
      "status": 200
    }
  ],
  "visible_items_metadata": {
    "observed_at_utc": "2026-11-14T11:21:25.291609+00:00",
    "content_range": "0-977/978",
    "fetched_rows": 978,
    "public_RLS_only": true,
    "external_id_matches": 978,
    "external_created_by_null": 972,
    "external_placeholder_count": 694,
    "external_null_or_empty_photo": 1,
    "zip_prefight_eligible": 282,
    "zip_backfill_eligible_ignoring_ai_status": 282,
    "external_path_shapes": {
      "supabase_public_url": 694,
      "null_or_other": 2,
      "api_storage": 282
    }
  },
  "intended_external_scope": {
    "visible_only": true,
    "created_by_null": true,
    "total": 972,
    "placeholder": 690,
    "stored_api_paths": 282,
    "null_or_empty": 0,
    "status_counts": {
      "보관중": 972
    },
    "photo_id_prefix_counts": {
      "POL": 261,
      "POR": 21
    }
  },
  "public_storage_HEAD": {
    "observed_at_utc": "2026-11-14T11:24:32.651551+00:00",
    "requests": 282,
    "status_counts": {
      "200": 282
    },
    "known_content_length": 282,
    "at_or_below_8000000": 278,
    "between_8000000_and_8MiB": 1,
    "above_8MiB": 3,
    "mime_counts": {
      "image/jpeg": 279,
      "image/png": 3
    },
    "limits": "Public HTTP headers only. Not storage.objects SQL metadata, image bytes, magic verification, or AI success."
  }
}
```

**로컬 재현 관측 결과**

결함 반례의 재현을 포함합니다. 운영 통합 시험 결과가 아닙니다.

```json
{
  "observations": 24,
  "findings": [
    {
      "name": "absolute_storage_URL_does_not_bind_item_ID",
      "evidence": {
        "relative_other": null,
        "absolute_other": "accepted"
      }
    },
    {
      "name": "substring_normalization_reverses_negation",
      "evidence": [
        "투명",
        "가죽",
        "무광"
      ]
    },
    {
      "name": "color_and_common_material_not_saved",
      "evidence": {
        "color_and_plastic": "discarded"
      }
    },
    {
      "name": "retry_classification_mismatch",
      "evidence": {
        "permanent_gemini_401": "retry",
        "missing_model": "retry",
        "transient_image_408": "terminal"
      }
    },
    {
      "name": "worker_handler_mock_normal_and_unauthorized",
      "evidence": {
        "unauthorized": 403,
        "normal": "done",
        "color_in_AI_response": "not persisted",
        "network": "stubbed"
      }
    },
    {
      "name": "worker_handler_mock_failure",
      "evidence": "Gemini permanent 401 is requested for retry"
    },
    {
      "name": "remote_image_boundaries",
      "evidence": {
        "accepted_bytes": 8000000,
        "rejected_bytes": 8000001,
        "remote_gif_heic": "rejected",
        "fixture": "synthetic JPEG signature, not a decoded real image"
      }
    },
    {
      "name": "IMAGE_URL_HOSTS_also_allows_subdomains",
      "evidence": true
    },
    {
      "name": "new_readonly_diagnostics_execute_on_local_fixture",
      "evidence": "3 SQL files, read-only transactions"
    },
    {
      "name": "original_preflight_SQL_fails",
      "evidence": {
        "code": "42703",
        "message": "column i.relname does not exist"
      }
    },
    {
      "name": "draft_migration_applies_on_repository_schema",
      "evidence": {
        "engine": "PostgreSQL 18.6 (PGlite 0.5.16) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.13 (e13ee988ce3d87a738dd8f3661d02223308c412a), 32-bit",
        "production_equivalence": false
      }
    },
    {
      "name": "normal_completion_and_duplicate_finish",
      "evidence": {
        "state": "done",
        "duplicate_commit": false,
        "original_memo_and_description": "preserved"
      }
    },
    {
      "name": "null_and_placeholder_exclusion",
      "evidence": "passed"
    },
    {
      "name": "retry_5m_15m_then_third_attempt_terminal",
      "evidence": "passed"
    },
    {
      "name": "photo_path_change_rejects_stale_lease",
      "evidence": "passed"
    },
    {
      "name": "same_storage_path_has_no_reanalysis_signal",
      "evidence": "state remains done; content changes are not observable in items"
    },
    {
      "name": "received_invalidates_lease_but_reopen_not_enqueued",
      "evidence": "not_applicable after reopen"
    },
    {
      "name": "expired_lease_recovery_rejects_old_finish",
      "evidence": "passed; external Gemini exactly-once is not established"
    },
    {
      "name": "no_global_one_job_per_minute_gate",
      "evidence": {
        "immediate_claims": 2,
        "different_items": true,
        "note": "sequential claims alone disprove the advertised cap; multi-session locking not tested"
      }
    },
    {
      "name": "pilot_selection_does_not_scope_worker_claim",
      "evidence": "an earlier automatically enqueued item is claimed instead"
    },
    {
      "name": "repository_RLS_private_denied_but_public_queue_columns_visible",
      "evidence": {
        "anon_private": "42501",
        "public_queue_columns_visible": true
      }
    },
    {
      "name": "staff_can_bypass_AI_feature_allowlist_by_direct_private_update",
      "evidence": "table-level UPDATE grant covers added columns"
    },
    {
      "name": "repository_RLS_authenticated_nonstaff_sees_no_private_rows",
      "evidence": "passed on repository policy"
    },
    {
      "name": "test_scope",
      "evidence": {
        "PostgreSQL": "PGlite single session",
        "Supabase_auth_storage_cron": "stubs",
        "Gemini_network": "none",
        "production_mutations": "none",
        "real_image_pilot": "not run"
      }
    }
  ]
}
```

<!-- 고현 수정 끝: 비밀값과 개별 운영 행을 제외한 검증 근거 -->
