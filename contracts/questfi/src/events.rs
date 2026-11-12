//! NEP-297 event logs: one line per event,
//! `EVENT_JSON:{"standard":"questfi","version":"1.0.0","event":"<name>","data":[{...}]}`.
//! Amounts are strings of yoctoNEAR, counts are numbers.

use near_sdk::env;
use near_sdk::serde_json::Value;

pub const EVENT_STANDARD: &str = "questfi";
pub const EVENT_VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

/// An amount as it appears in JSON.
pub fn amt(v: u128) -> String {
    v.to_string()
}
