//! 浏览器执行权只在会话入口裁决；API 的状态不能替代节点当前租约和代次。
use crate::{
    error::{Fault, Result},
    process,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// 控制面经已认证主连接安装的短期能力凭证；节点仅保存令牌摘要。
pub struct Grant {
    /// 授权关联的介入身份或只读观看身份。
    pub id: String,
    /// 随机连接凭据的 SHA-256 摘要，不保存原始令牌。
    pub token_hash: String,
    /// 首次连接的绝对截止时间，单位毫秒。
    pub connect_expires_at: u64,
    /// 人工链接或只读观看的绝对截止时间。
    pub expires_at: u64,
    /// 允许连接的 Console 精确来源。
    pub origin: String,
    /// 当前已知认证版本；与控制权代次独立。
    pub auth_revision: u64,
    /// API 核实过的待办视图，不含平台和节点密钥。
    pub state: Value,
}
/// 同一会话的唯一控制状态；进程重启会关闭会话，不恢复旧人工凭证。
#[derive(Default)]
pub struct Control {
    /// 控制权代次，用于拒绝旧页面和旧自动动作。
    pub revision: u64,
    /// 当前是否归人工控制。
    pub human: bool,
    /// 当前人工能力；同一会话最多一个。
    pub grant: Option<Grant>,
    /// 当前已知认证版本；与控制权代次独立。
    pub auth_revision: u64,
    /// 唯一人工控制连接是否仍持有授权。
    pub connected: bool,
    /// 控制凭据是否已经消费；断线后必须重新签发。
    pub consumed: bool,
    /// 完成提交后冻结输入，直到新的控制代次。
    pub finalizing: bool,
    /// 完成事件等待控制面确认，重连只能查询，不重放操作。
    pub completion: Option<Value>,
    /// 转换为本机单调时钟的授权期限。
    deadline: u64,
    /// 只读凭证不取得操作权，数量与有效期有界。
    watches: std::collections::HashMap<String, (Grant, u64, bool)>,
}
impl Control {
    /// 观看授权独立于人工授权；切换代次后自动失效。
    pub fn watch(&mut self, value: &Value) -> Result<()> {
        self.authorize(false, value["revision"].as_u64().unwrap())?;
        self.watches
            .retain(|_, (_, deadline, _)| *deadline > process::boot_ms());
        if self.watches.len() >= 32 {
            return Err(Fault::rejected("VIEWERS_BUSY", "观看授权已达网络保护上限"));
        }
        let grant: Grant = serde_json::from_value(value["grant"].clone())
            .map_err(|_| Fault::rejected("INVALID_GRANT", "观看授权无效"))?;
        let deadline = process::boot_ms() + grant.expires_at.saturating_sub(unix_ms());
        self.watches
            .insert(grant.id.clone(), (grant, deadline, false));
        Ok(())
    }
    /// 匹配只读身份，不能因此授予控制权。
    pub fn has_watch(&self, id: &str) -> bool {
        self.watches.contains_key(id)
    }
    /// 首次消费只读凭证，绑定 Origin 和连接期限。
    pub fn watch_auth(&mut self, id: &str, token: &str, origin: &str) -> Result<Grant> {
        if self.human {
            return Err(Fault::rejected("CONTROL_CHANGED", "画面已交给人工"));
        }
        let (grant, deadline, used) = self
            .watches
            .get_mut(id)
            .ok_or_else(|| Fault::rejected("HITL_INVALID", "观看凭证无效"))?;
        if *used
            || *deadline <= process::boot_ms()
            || grant.connect_expires_at <= unix_ms()
            || grant.origin != origin
            || grant.token_hash != hex::encode(Sha256::digest(token.as_bytes()))
        {
            return Err(Fault::rejected("HITL_INVALID", "观看凭证失效"));
        }
        *used = true;
        Ok(grant.clone())
    }
    /// 流持续检查代次与有效期，撤权无需等待新帧。
    pub fn watch_active(&self, id: &str, revision: u64) -> Result<()> {
        self.authorize(false, revision)?;
        if self
            .watches
            .get(id)
            .is_none_or(|(_, deadline, used)| !used || *deadline <= process::boot_ms())
        {
            return Err(Fault::rejected("HITL_ENDED", "观看授权到期"));
        }
        Ok(())
    }
    /// 安装控制代次或人工连接凭证；相同代次不能改变操作者。
    pub fn change(&mut self, value: &Value) -> Result<()> {
        let revision = value["revision"].as_u64().unwrap();
        let human = value["mode"] == "HUMAN";
        if revision < self.revision || (revision == self.revision && human != self.human) {
            return Err(Fault::rejected("CONTROL_CHANGED", "控制代次已变化"));
        }
        let grant = value
            .get("grant")
            .map(|g| serde_json::from_value::<Grant>(g.clone()))
            .transpose()
            .map_err(|_| Fault::rejected("INVALID_GRANT", "直连授权无效"))?;
        if grant.is_some() && (!human || self.connected) {
            return Err(Fault::rejected("HITL_OCCUPIED", "人工连接已被占用"));
        }
        if revision > self.revision {
            self.watches.clear();
            self.grant = None;
            self.connected = false;
            self.consumed = false;
            self.finalizing = false;
            self.completion = None;
        }
        self.revision = revision;
        self.human = human;
        if let Some(grant) = grant {
            self.deadline =
                process::boot_ms().saturating_add(grant.expires_at.saturating_sub(unix_ms()));
            self.auth_revision = self.auth_revision.max(grant.auth_revision);
            self.grant = Some(grant);
            self.consumed = false;
        }
        Ok(())
    }
    /// 浏览器命令统一检查操作者；交接完成中不接收新输入。
    pub fn authorize(&self, human: bool, revision: u64) -> Result<()> {
        if self.revision != revision || self.human != human || self.finalizing {
            return Err(Fault::rejected("CONTROL_CHANGED", "浏览器执行权已变化"));
        }
        Ok(())
    }
    /// 浏览器 Origin 与首次消息双重绑定；媒体只能依附已经取得的人工连接。
    pub fn authenticate(
        &mut self,
        id: &str,
        token: &str,
        origin: &str,
        media: bool,
    ) -> Result<Grant> {
        let grant = self
            .grant
            .as_ref()
            .ok_or_else(|| Fault::rejected("HITL_INVALID", "人工授权不存在"))?;
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        if !self.human
            || grant.id != id
            || grant.token_hash != hash
            || grant.origin != origin
            || process::boot_ms() >= self.deadline
            || (!media && unix_ms() >= grant.connect_expires_at)
            || (media && !self.connected)
        {
            return Err(Fault::rejected("HITL_INVALID", "人工授权已失效"));
        }
        if !media {
            if self.connected || self.consumed {
                return Err(Fault::rejected(
                    "HITL_OCCUPIED",
                    "连接凭证已使用，请重新申请",
                ));
            }
            self.connected = true;
            self.consumed = true;
        }
        Ok(grant.clone())
    }
    /// 已建立的连接仍受授权期限、控制代次和当前连接身份约束。
    pub fn active(&self, hash: &str, revision: u64) -> Result<()> {
        if !self.human
            || !self.connected
            || self.revision != revision
            || process::boot_ms() >= self.deadline
            || self.grant.as_ref().is_none_or(|g| g.token_hash != hash)
        {
            return Err(Fault::rejected("HITL_ENDED", "人工控制已结束"));
        }
        Ok(())
    }
}
/// 仅用于校验控制面给出的绝对有效期；接入后使用本机单调时钟。
pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn grant(id: &str) -> Value {
        json!({"id":id,"tokenHash":hex::encode(Sha256::digest(b"fixture-token-with-at-least-32-characters")),"connectExpiresAt":unix_ms()+60_000,"expiresAt":unix_ms()+120_000,"origin":"https://console.test","authRevision":5,"state":{"type":"state"}})
    }
    // 范围：控制代次、单处理者、Origin 和一次性凭证；不建立真实网络或浏览器。
    #[test]
    fn handoff_fences_old_commands_and_credentials() {
        let mut control = Control::default();
        control
            .change(&json!({"mode":"HUMAN","revision":1,"grant":grant("human")}))
            .unwrap();
        assert!(control.authorize(false, 0).is_err());
        assert!(
            control
                .authenticate(
                    "human",
                    "fixture-token-with-at-least-32-characters",
                    "https://evil.test",
                    false
                )
                .is_err()
        );
        control
            .authenticate(
                "human",
                "fixture-token-with-at-least-32-characters",
                "https://console.test",
                false,
            )
            .unwrap();
        assert!(
            control
                .authenticate(
                    "human",
                    "fixture-token-with-at-least-32-characters",
                    "https://console.test",
                    false
                )
                .is_err()
        );
        control.connected = false;
        assert!(
            control
                .authenticate(
                    "human",
                    "fixture-token-with-at-least-32-characters",
                    "https://console.test",
                    false
                )
                .is_err()
        );
        control
            .change(&json!({"mode":"AUTO","revision":2}))
            .unwrap();
        assert!(control.authorize(true, 1).is_err());
        assert!(control.authorize(false, 2).is_ok());
        assert!(
            control
                .change(&json!({"mode":"HUMAN","revision":1}))
                .is_err()
        );
    }
    // 范围：只读凭证不能取得输入权，代次切换撤销观看；不覆盖真实流服务背压。
    #[test]
    fn watch_is_read_only_and_revoked_on_handoff() {
        let mut control = Control::default();
        control
            .watch(&json!({"revision":0,"grant":grant("watch")}))
            .unwrap();
        assert!(
            control
                .authenticate(
                    "watch",
                    "fixture-token-with-at-least-32-characters",
                    "https://console.test",
                    false
                )
                .is_err()
        );
        control
            .watch_auth(
                "watch",
                "fixture-token-with-at-least-32-characters",
                "https://console.test",
            )
            .unwrap();
        assert!(control.watch_active("watch", 0).is_ok());
        control
            .change(&json!({"mode":"HUMAN","revision":1}))
            .unwrap();
        assert!(control.watch_active("watch", 0).is_err());
    }
    // 范围：断线重连不能解除完成冻结或回退认证版本；不模拟控制面数据库提交。
    #[test]
    fn reconnect_preserves_finalization_and_auth_revision() {
        let mut control = Control::default();
        control
            .change(&json!({"mode":"HUMAN","revision":1,"grant":grant("human")}))
            .unwrap();
        control.finalizing = true;
        control.auth_revision = 8;
        control
            .change(&json!({"mode":"HUMAN","revision":1,"grant":grant("human")}))
            .unwrap();
        assert!(control.finalizing);
        assert_eq!(control.auth_revision, 8);
        assert!(control.authorize(true, 1).is_err());
    }
}
