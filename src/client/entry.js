/**
 * dsh-recall-plugin — client 构建入口（esbuild 打包）
 *
 * 这是 src/client/ 多文件的唯一构建入口：esbuild 把它与 app/util/recall-node/
 * settings-cards/css 打包成单文件 lib/client.js，react 标记 external——由
 * factory 的 require("react") 在运行时从 loader 平台模块表提供。
 *
 * loader 契约（spike 核验）：window.__ModuleLoader__.load({id, factory})，
 * factory 是 CJS 风格同步 require，只认「包名」粒度；bundle 以 classic
 * <script> 原文 serve，顶层 import 会 SyntaxError 拒载。因此产物必须是
 * 单文件 factory 注册格式，不能是 ESM 多文件相对 import。
 */

import { createApp } from './app.js'

window.__ModuleLoader__.load({
  id: 'dsh-recall-plugin',
  factory: (require) => {
    const React = require('react')
    return { name: 'dsh-recall-plugin', apply: createApp(React) }
  }
})
