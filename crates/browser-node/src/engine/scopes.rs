//! 同一 profile 内的标签页作用域。切页和实际命令在 session-host 的同一串行队列内完成。
use super::{Engine, dom};
use crate::error::{Fault, Result};
use std::collections::HashMap;

/// 最大业务分组数加一个统一清理 tab；不包含引擎启动页。
const MAX_PROFILE_TABS: usize = 33;

/// 每页独立保存元素映射和观察身份，其他组切页不能替换这些引用。
#[derive(Default)]
pub(super) struct TabState {
    /// 引擎分配的 tab 身份，不使用易变化的位置编号。
    pub tab_id: String,
    /// 本组最后一次观察身份。
    pub observation: Option<String>,
    /// 旧引擎回退路径的元素引用映射。
    pub targets: HashMap<String, String>,
    /// 本 tab 的原生 DOM 节点映射和 CDP 连接。
    pub dom: Option<dom::Dom>,
    /// 当前观察的可视画面及有效期。
    pub visual: Option<super::visual::VisualObservation>,
    /// 模型可见的本组标签页列表。
    pub tabs: Vec<String>,
    /// 本 tab 当前选择的 frame。
    pub frame: Option<String>,
}

impl Engine {
    /// 激活平台分组绑定的 tab；模型不能通过 tab.switch 抢占其他分组的页面。
    pub(super) async fn activate_scope(&mut self, scope: &str, timeout: u64) -> Result<()> {
        if self.active_scope.as_deref() == Some(scope) {
            // 人工或弹窗可能改变实际活动页，每次命令都重新定位绑定页。
            let id = self.scopes[scope].tab_id.clone();
            self.cli(vec!["tab".into(), id], timeout).await?;
            return Ok(());
        }
        if let Some(previous) = self.active_scope.take() {
            let state = self.scopes.get_mut(&previous).unwrap();
            state.observation = self.observation.take();
            state.targets = std::mem::take(&mut self.targets);
            state.dom = self.dom.take();
            state.visual = self.visual.take();
            state.tabs = std::mem::take(&mut self.tabs);
            state.frame = self.frame.take();
        }
        if !self.scopes.contains_key(scope) {
            if self.scopes.len() >= MAX_PROFILE_TABS {
                return Err(Fault::rejected("TAB_LIMIT", "profile tab limit reached"));
            }
            self.cli(
                vec!["tab".into(), "new".into(), "about:blank".into()],
                timeout,
            )
            .await?;
            let listed = self.cli(vec!["tab".into(), "list".into()], timeout).await?;
            let tab = listed["tabs"]
                .as_array()
                .and_then(|tabs| tabs.iter().find(|t| t["active"] == true))
                .and_then(|t| t["tabId"].as_str())
                .ok_or_else(|| Fault::unknown("TAB_MISSING", "new tab not identified"))?;
            self.scopes.insert(
                scope.to_owned(),
                TabState {
                    tab_id: tab.into(),
                    ..Default::default()
                },
            );
        } else {
            let id = self.scopes[scope].tab_id.clone();
            self.cli(vec!["tab".into(), id], timeout).await?;
        }
        let state = self.scopes.get_mut(scope).unwrap();
        self.observation = state.observation.take();
        self.targets = std::mem::take(&mut state.targets);
        self.dom = state.dom.take();
        self.visual = state.visual.take();
        self.tabs = std::mem::take(&mut state.tabs);
        self.frame = state.frame.take();
        self.active_scope = Some(scope.into());
        Ok(())
    }
}
