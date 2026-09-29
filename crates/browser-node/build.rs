// NodeCommand 的 JSON Schema 是跨语言协议源文件；Rust 类型仅在构建期生成。
fn main() {
    let path = "../../contracts/schemas/node-command.schema.json";
    println!("cargo:rerun-if-changed={path}");
    let schema = std::fs::read_to_string(path).expect("read node schema");
    let mut types = typify::TypeSpace::default();
    types
        .add_root_schema(serde_json::from_str(&schema).expect("parse node schema"))
        .expect("generate node types");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(out.join("node_protocol.rs"), types.to_stream().to_string())
        .expect("write generated types");
}
