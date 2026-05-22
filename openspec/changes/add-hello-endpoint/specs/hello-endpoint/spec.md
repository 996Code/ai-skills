# 规格：hello-endpoint

## 新增（ADDED）

### `GET /hello`

返回问候消息。

**请求**：
- 方法：`GET`
- 路径：`/hello`
- 无请求参数
- 无请求体

**响应（200 OK）**：
- Content-Type：`application/json`
- 响应体：
  ```json
  {
    "message": "你好，世界！"
  }
  ```

**验收标准**：
- [ ] 返回 HTTP 200
- [ ] 响应体为合法 JSON
- [ ] 响应体包含 `message` 字段，值为 `"你好，世界！"`
- [ ] Content-Type 头为 `application/json`
