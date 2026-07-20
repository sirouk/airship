use wasm_bindgen::prelude::*;
use dcap_qvl::quote::{Quote, Report};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedTdxQuote {
    version: u16,
    attestation_key_type: u16,
    tee_type: u32,
    body_type: u16,
    report_body_offset: usize,
    report_body_length: usize,
    signature_data_length: u32,
    report_data: Vec<u8>,
    mrtd: Vec<u8>,
    rtmr0: Vec<u8>,
    rtmr1: Vec<u8>,
    rtmr2: Vec<u8>,
    rtmr3: Vec<u8>,
}

/// Parse and normalize Intel TDX quote v4/v5 using the exact same Rust parser
/// used by the verifier. This prevents the browser from inventing offsets for
/// quote-v5 TDX 1.0/1.5 bodies.
#[wasm_bindgen]
pub fn parse_quote(raw_quote: JsValue) -> Result<JsValue, JsValue> {
    let raw: Vec<u8> = serde_wasm_bindgen::from_value(raw_quote)
        .map_err(|error| JsValue::from_str(&format!("Invalid quote byte array: {error}")))?;
    let quote = Quote::parse(&raw)
        .map_err(|error| JsValue::from_str(&format!("Invalid Intel quote: {error:#}")))?;
    if quote.header.tee_type != 0x81 {
        return Err(JsValue::from_str("Quote is not Intel TDX."));
    }
    let (body_type, report_body_length, report) = match &quote.report {
        Report::TD10(report) => (2, 584, report),
        Report::TD15(report) => (3, 648, &report.base),
        Report::SgxEnclave(_) => return Err(JsValue::from_str("Quote is not Intel TDX.")),
    };
    let report_body_offset = if quote.header.version == 5 { 54 } else { 48 };
    let signature_length_offset = report_body_offset + report_body_length;
    let length_bytes = raw
        .get(signature_length_offset..signature_length_offset + 4)
        .ok_or_else(|| JsValue::from_str("Quote is truncated before signature-data length."))?;
    let signature_data_length = u32::from_le_bytes(length_bytes.try_into().expect("four-byte slice"));
    let expected_length = signature_length_offset + 4 + signature_data_length as usize;
    if raw.len() < expected_length {
        return Err(JsValue::from_str("Quote is truncated before signature data."));
    }
    serde_wasm_bindgen::to_value(&ParsedTdxQuote {
        version: quote.header.version,
        attestation_key_type: quote.header.attestation_key_type,
        tee_type: quote.header.tee_type,
        body_type,
        report_body_offset,
        report_body_length,
        signature_data_length,
        report_data: report.report_data.to_vec(),
        mrtd: report.mr_td.to_vec(),
        rtmr0: report.rt_mr0.to_vec(),
        rtmr1: report.rt_mr1.to_vec(),
        rtmr2: report.rt_mr2.to_vec(),
        rtmr3: report.rt_mr3.to_vec(),
    })
    .map_err(|error| JsValue::from_str(&format!("Could not serialize parsed quote: {error}")))
}

/// Fetch a complete Intel collateral bundle in the browser. The PCCS is only
/// transport: dcap-qvl validates Intel signatures, chains, CRLs, identities,
/// TCB status, and validity windows before returning a verified report.
#[wasm_bindgen]
pub async fn get_collateral(pccs_url: JsValue, raw_quote: JsValue) -> Result<JsValue, JsValue> {
    dcap_qvl::verify::js_get_collateral(pccs_url, raw_quote).await
}

/// Run Phala's pure-Rust Intel DCAP QVL locally inside the browser.
#[wasm_bindgen]
pub fn verify_quote(
    raw_quote: JsValue,
    quote_collateral: JsValue,
    now_seconds: u64,
) -> Result<JsValue, JsValue> {
    dcap_qvl::verify::js_verify(raw_quote, quote_collateral, now_seconds)
}
