//! NEP-297 events (docs/SPEC.md section 4.6):
//! `EVENT_JSON:{"standard":"surety","version":"1.0.0","event":"<name>","data":[{...}]}`
//! `data[0]` always includes `job_id` and/or `agent_id` plus the amounts involved.

use near_sdk::{log, serde_json::{json, Value}};

pub fn emit(event: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": "surety", "version": "1.0.0", "event": event, "data": [data] })
    );
}
