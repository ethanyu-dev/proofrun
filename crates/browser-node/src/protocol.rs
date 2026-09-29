// 公共命令类型与 TS 共用 JSON Schema 源文件；不要在 Rust 中另写同名协议。
#[allow(clippy::all)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/node_protocol.rs"));
}
pub use generated::*;

/// 先以原始 JSON Schema 校验消息，再反序列化为生成类型。
/// 生成枚举未必能表达所有 Schema 约束，尤其是无字段变体的额外属性。
pub fn parse_command(value: serde_json::Value) -> crate::error::Result<NodeCommand> {
    static SCHEMA: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new();
    let validator = SCHEMA.get_or_init(|| {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/node-command.schema.json"
        ))
        .expect("embedded schema");
        jsonschema::validator_for(&schema).expect("valid embedded schema")
    });
    if !validator.is_valid(&value) {
        return Err(crate::error::Fault::rejected(
            "INVALID_COMMAND",
            "message does not match node-command schema",
        ));
    }
    serde_json::from_value(value)
        .map_err(|_| crate::error::Fault::rejected("INVALID_COMMAND", "cannot decode command"))
}
