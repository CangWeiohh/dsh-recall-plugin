/**
 * dsh-recall-plugin — client 装配（apply 组装各子模块）
 *
 * 原 lib/client.js 的 apply(ctx) 主体：注入 CSS、组装 util / 撤回节点 /
 * 设置卡片，注册 chat.node（user+steering，负值 priority 冲突递减重试）与
 * settings.plugin.item（key=namespace 'dsh-recall'）。React 由构建入口的
 * factory 通过 require("react") 传入（loader 平台模块表提供）。
 */

import { CSS } from './css.js'
import { buildUtil } from './util.js'
import { buildRecallNode } from './recall-node.js'
import { buildSettingsCards } from './settings-cards.js'

export function createApp(React) {
  return function apply(ctx) {
    const slots = ctx.get('slots')
    if (!slots) return
    // 官方会话服务：fork 到已完成 turn 前缀 + open 切到新会话；
    // workspaces 的归档只是从列表隐藏、可恢复，用来收走回退前的原会话。
    const sessionsSvc = ctx.get('sessions')
    const workspacesSvc = ctx.get('workspaces')

    // 静态 bundle 的 ctx 可能不提供 styles 服务，降级为直接注入 <style>
    const stylesSvc = ctx.get('styles')
    if (stylesSvc && typeof stylesSvc.insert === 'function') {
      stylesSvc.insert(CSS)
    } else if (typeof document !== 'undefined') {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-recall-plugin')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const util = buildUtil()
    const { UserRecallNode } = buildRecallNode(React, util, ctx, sessionsSvc, workspacesSvc)
    const { RecallSettingsCard } = buildSettingsCards(React, util, sessionsSvc)

    // keyed slot 显式用低于默认 0 的 priority 注册：默认 0 通常被平台/其他
    // 插件的渲染器占据，不指定 priority 会因 keyed slot 冲突拒载整个插件；
    // lowest renders，负值恰好覆盖默认渲染器实现撤回 UI。priority -1 也可能
    // 被别的机器上的插件占用（同样抛冲突），所以递减重试三次——最坏情况只是
    // 撤回按钮不渲染，绝不让插件加载失败。chat.node 的 keyed key 与节点 UI
    // 投影 kind 对齐：'user' 是常规用户消息；'steering' 是 agent 运行中插入
    // 的转向指令——官方仍按用户气泡回显，但 keyed 'user' 不命中，会落到默认
    // 渲染、撤回按钮缺失。两个 key 各自独立注册，互不抢占。
    for (const slotKey of ['user', 'steering']) {
      let mounted = false
      for (let priority = -1; priority >= -3 && !mounted; priority--) {
        try {
          slots.inject('conversation.chat.node', () => slots.register(
            { name: 'conversation.chat.node', key: slotKey, priority },
            UserRecallNode
          ))
          mounted = true
        } catch (error) {
          if (priority === -3) console.error('[dsh-recall-plugin] slot register failed (' + slotKey + '):', error)
        }
      }
    }

    // 「插件配置」分区挂撤回卡片：settings.plugin.item 是 root 级 keyed slot
    // （官方 ui-settings-plugins 的 configurable 标签页声明，按 settings
    // namespace 作为 entryKey 分发）。key 必须与 Host 端注册的 namespace
    // 'dsh-recall' 一致——卡片只渲染「Host 服务的 namespace」与「slot 注册的
    // 卡片」的交集。各 namespace 独占自己的 key，无同 key 抢占，不需要
    // priority（与 conversation.chat.node 覆盖默认渲染器是两套语义）。
    try {
      slots.inject('settings.plugin.item', () => slots.register(
        { name: 'settings.plugin.item', key: 'dsh-recall' },
        RecallSettingsCard
      ))
    } catch (error) {
      console.error('[dsh-recall-plugin] settings card register failed:', error)
    }
  }
}
