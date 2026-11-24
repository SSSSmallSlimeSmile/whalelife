# 可选本地诊断输出

此功能用于核对实际模型输入、响应、工具步骤和服务返回的用量。主干只负责输出通用文件，不依赖任何查看工具，不提供自动分析、计费推断、重放或插件业务调度。

## 开关与存储

默认关闭；关闭时不创建诊断目录、不读写诊断文件。管理员在本地 `config/config.json` 配置并重启：

```json
{
  "diagnostics": {
    "enabled": true,
    "directory": "D:/WhaleLifeDiagnostics"
  }
}
```

`directory` 必须是独立的本机绝对路径，不能处于应用源码、实际记忆或日志目录内，也不能是这些目录的祖先；不接受网络共享或符号链接路径。上例只是示例，Linux 可使用独立的 `/var/lib/whalelife-diagnostics`。目录不合法或不可写只会停用采集并提示，不阻止核心启动。

每次启动有独立 `instance_id` 和递增序号。文件为 UTF-8 JSONL，附件写在 `attachments/`；没有自动过期删除。关闭查看器不影响写入，查看器也不需要反向调用主干。记录可能包含完整人格、历史、临时任务资料、模型思考和图片，应留在本机独立目录，不能随源码提交。已知密钥、认证头、Cookie 和 URL 凭据会遮盖，数字 token 用量保留。无法自动识别所有自然语言中的个人秘密；采集权限等同于读取完整请求的权限。

## 实际覆盖范围

| 路径 | 记录内容 |
| --- | --- |
| Web、渠道与插件会话入口 | 本次执行、会话归属、组装材料、输入追加、工具续轮和每次真实模型请求 |
| 日记及旧记忆整理入口 | 与聊天区分的 purpose、完整请求和服务实际返回的 usage |
| 插件 `ctx.llm.chat` | 核心代理实际发出的请求及可信插件归属；没有会话信息时保持未知 |
| 模型配置连通测试、维度检测、模型元数据 | 核心发出的 HTTP 请求、响应和可获得的 usage |
| 核心工具调用 | 参数、结果、错误；多模态及临时正文进入诊断，不改变普通记忆的隔离规则 |

插件获取 `models.connection()` 后自行使用 SDK/HTTP 发出的请求不经过此采集点，明确属于未覆盖范围。不能从某段提示词、时间接近或插件名称推断父任务，也不声称能看到服务内部隐藏的推理或实际账单。获取连接本身不是一次模型请求。

HTTP 错误沿用业务原有的限量读取；记录会说明正文完整、截断或未知边界，不为采集重新请求或额外读取无限正文。SSE 记录原消费者读到的解析事件、文本、思考和工具增量。解析前的无效或不完整流不能当作完整响应。

## 事件协议 v1

每行是一个 JSON 对象：

```json
{
  "schema_version": 1,
  "event_id": "unique-event-id",
  "producer_id": "whalelife",
  "instance_id": "unique-process-instance",
  "sequence": 1,
  "ts": "2026-01-01T00:00:00.000Z",
  "kind": "request.start",
  "execution_id": "execution-id",
  "request_id": "request-id",
  "data": {
    "purpose": "chat",
    "protocol": "openai-compatible",
    "model": "configured-model",
    "body": { "model": "configured-model", "messages": [] }
  }
}
```

可选归属字段包括 `session_id`、`plugin_id`、`tool_call_id`、`task_id`、`parent_execution_id`、`relation_verified`、`purpose`。不存在的信息省略，不虚构任务 ID。新增字段和未知事件应由读取方保留或忽略，不使旧读取器崩溃；不兼容语义另升 schema 版本。

- `coverage`：当前采集边界。
- `execution.start/end`：核心掌握的执行开始、结束及状态。
- `request.start`：序列化后的实际请求体、模型、协议、用途、方法、脱敏地址和请求头。prepared 不代表已经发送；传输开始信息与收到的 HTTP 状态在后续事件记录。
- `response.chunk`：实际已读响应、HTTP 状态、流式增量或已解析的 JSON。
- `request.usage`：原始服务用量，`mode: snapshot` 表示快照，不能把同一请求的多个快照相加；`stage: interim/final` 区分过程和最终结果。
- `request.end`：每次请求的完成、失败或取消，保留实际 HTTP 状态。失败请求若收到 interim usage，仍应显示它；没有数字应显示未知，不能当成零。
- `context.change`：组装来源、追加输入、时间刷新、模型工具调用和工具结果。最终送出内容始终以该次 `request.start.body` 为准。
- `tool.start/end/error`、`execution.error`：核心观察到的步骤与失败。工具成功不自动代表外部业务目标完成。
- `capture.gap`：采集缺失及丢弃数量。不得把不完整记录显示成完整请求。

渠道来信的图片仅在当轮使用。处理这些图片的主模型请求与渠道辅助识图回调里的 `ctx.llm.chat` 请求记录状态和用量，`request.start` 标明 `body_omitted: "channel_images"`。这些请求的原始请求体、响应片段和原图不会写入诊断附件。

其他可采集的媒体使用相对路径引用，先写附件再落事件：

```json
{"$attachment":{"path":"attachments/content-hash.bin","mime":"application/octet-stream","sha256":"content-hash"}}
```

读取方只应从诊断根目录解析相对路径，不跟随链接、远程下载或执行记录中的内容。只有换行结束的 JSONL 行可以作为完整提交读取；event_id 可用于去重。

## 故障与性能边界

业务路径只做有上限的快照和入队，磁盘写入异步进行；没有新增模型调用或重试。队列默认 128 MiB，单事件默认 64 MiB，可用 `max_queue_bytes`、`max_event_bytes` 调整。完整采集会额外消耗本机 CPU、内存与磁盘；超大内容、队列已满或磁盘故障时允许丢弃采集，记录缺口和告警，不能阻塞聊天来等待查看工具。

已认证的 `/api/status` 提供 `diagnostics` 状态，包括是否启用、待写数量、丢弃量与缺口状态；退出时有限等待写完。无限卡住或进程强制退出可能留下不完整尾行，不能承诺每次异常退出零丢失。此目录不属于普通日志轮转，也不进入记忆、备份或自动召回。

## 验证

`tests/diagnostics.test.ts` 验证采集器隔离、脱敏、附件、队列、故障和关闭；`tests/model-diagnostics.test.ts` 验证真实本机 HTTP/SSE 边界；`tests/diagnostic-integration.test.ts` 验证会话、工具、临时资料、插件 LLM 与日记。测试使用独立合成数据，不调用付费模型，不发送平台消息。
