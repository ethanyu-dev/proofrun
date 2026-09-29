//! 一次性注册只负责机器身份与凭据，不启动浏览器，也不承担任务定义。
use crate::{artifacts, config::NodeConfig, gateway};
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};

/// 配对响应只包含少量配置，限制读取避免异常服务响应占用内存。
const MAX_RESPONSE_BYTES: usize = 8192;

/// 从配置网关推导同源 HTTPS 配对入口，将凭据写入节点私有文件。
pub async fn pair(
    config: &NodeConfig,
    token_file: &Path,
    replace_credential: bool,
) -> Result<Value> {
    gateway::validate_endpoint(&config.gateway_url)?;
    let mut endpoint = reqwest::Url::parse(&config.gateway_url)?;
    let scheme = match endpoint.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => anyhow::bail!("gateway_url must use ws/wss"),
    };
    endpoint
        .set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("invalid pairing scheme"))?;
    endpoint.set_path("/v1/nodes/pair");
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    std::fs::create_dir_all(&config.home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config.home, std::fs::Permissions::from_mode(0o700))?;
    }
    let _lock = artifacts::lock_home(&config.home)?;
    ensure!(
        replace_credential || !config.credential_file.exists(),
        "credential file already exists; refusing to replace an existing identity"
    );
    let node_id = artifacts::installation_id(&config.home)?;
    let pairing_token = std::fs::read_to_string(token_file).context("read pairing token file")?;
    ensure!(
        (32..=256).contains(&pairing_token.trim().len()),
        "invalid pairing token length"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client.post(endpoint).json(&json!({"type":"node.pair","nodeId":node_id,"pool":config.pool,"pairingToken":pairing_token.trim()}))
        .send().await?.error_for_status()?;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(
            body.len() + chunk.len() <= MAX_RESPONSE_BYTES,
            "oversized pairing response"
        );
        body.extend_from_slice(&chunk);
    }
    let receipt: Value = serde_json::from_slice(&body)?;
    ensure!(
        receipt["nodeId"] == node_id
            && receipt["pool"] == config.pool
            && receipt["protocolVersion"] == "0.1",
        "pairing identity mismatch"
    );
    let token = receipt["token"]
        .as_str()
        .filter(|value| (32..=256).contains(&value.len()))
        .context("missing machine credential")?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let temporary = config
        .credential_file
        .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = options
        .open(&temporary)
        .context("write machine credential")?;
    file.write_all(serde_json::to_string(&json!({"token":token}))?.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temporary, &config.credential_file)?;
    std::fs::File::open(
        config
            .credential_file
            .parent()
            .context("credential parent missing")?,
    )?
    .sync_all()?;
    // 输出不包含机器密钥；地址供操作人员核对已有 TOML 配置。
    Ok(
        json!({"paired":true,"nodeId":node_id,"pool":config.pool,"gatewayUrl":receipt["gatewayUrl"],"artifactUploadUrl":receipt["artifactUploadUrl"]}),
    )
}
