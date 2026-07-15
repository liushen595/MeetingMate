# Frontend Handwriting Convert Adaptation

This document describes how PC and mobile clients should integrate with backend handwriting recognition during manuscript conversion.

## Summary

The backend now recognizes `handwriting` manuscript blocks inside `POST /api/v1/tasks/convert-manuscript`.

Clients do not need to call a separate handwriting OCR API for the conversion flow. The backend renders handwriting `strokes` to a PNG image, sends that bitmap to the vision model with a handwriting-specific JSON prompt, and writes the result into the generated `Document`.

The conversion task does not modify the source `Manuscript`. In particular, clients must not wait for `ManuscriptHandwritingBlock.props.ai_text` to be updated by this task.

## Conversion Request

Endpoint:

```http
POST /api/v1/tasks/convert-manuscript
Authorization: Bearer <access_token>
X-Client-Id: <client_id>
Idempotency-Key: <unique_key>
Content-Type: application/json
```

Body:

```json
{
  "manuscript_id": "manuscript_xxx",
  "mode": "meeting_minutes",
  "title": "会议纪要",
  "client_id": "device_xxx",
  "optimize_audio": true
}
```

`optimize_audio` is required. If the client does not want audio cleanup, send `false` explicitly.

## Required Client Flow

1. Flush all pending manuscript block sync operations.
2. Call `POST /api/v1/tasks/convert-manuscript`.
3. Treat the `202` response as a queued task, not as the final document.
4. Poll `GET /api/v1/tasks/{task_id}` until the task reaches a terminal state.
5. If `status == "succeeded"`, read `task.result.document_id`.
6. Fetch `GET /api/v1/documents/{document_id}` and open the generated document.
7. If `task.result.warnings` exists, show a non-blocking degraded-content notice.

Do not assume `task.result.document_id` is present in the first `202` response.

## Handwriting Block Payload

The source manuscript block should continue to use the existing `handwriting` schema:

```json
{
  "id": "block_hw_1",
  "type": "handwriting",
  "revision": 1,
  "created_at": "2026-07-15T00:00:00Z",
  "updated_at": "2026-07-15T00:00:00Z",
  "author_id": "user_xxx",
  "client_id": "device_xxx",
  "platform": "web",
  "deleted": false,
  "props": {
    "strokes": [
      {
        "id": "stroke_1",
        "tool": "pen",
        "color": "#111111",
        "width": 2,
        "points": [
          { "x": 10, "y": 10, "t": 0, "pressure": 0.5 },
          { "x": 120, "y": 30, "t": 16, "pressure": 0.5 }
        ]
      }
    ],
    "image_asset_id": null,
    "ai_text": ""
  }
}
```

Client notes:

- `strokes` are enough for conversion. The backend renders them to PNG.
- `image_asset_id` is optional.
- If `image_asset_id` is supplied as the only source for recognition, upload a bitmap format such as PNG, JPEG, WebP, or BMP.
- Do not upload SVG as the only `image_asset_id` for handwriting recognition. The backend will not send SVG to the model.
- Keep each handwriting block under the backend limits: 5000 total points and 256KB serialized block JSON.

## Generated Document Output

For each source `handwriting` block, the generated document may contain:

- A `heading` block when recognized text is short and heading-like.
- A `paragraph` block for regular recognized handwriting text.
- An `image` block before the text when the model reports a keepable drawing, diagram, flowchart, or sketch.

All generated blocks include `source_refs` pointing back to the original handwriting block.

Example output sequence:

```json
[
  {
    "type": "image",
    "props": {
      "asset_id": "asset_rendered_png",
      "caption": "手写流程图",
      "width": 320,
      "height": 120
    },
    "source_refs": [{ "manuscript_id": "manuscript_xxx", "block_id": "block_hw_1", "range": null, "region": null }]
  },
  {
    "type": "heading",
    "props": {
      "level": 2,
      "content": "移动端优先推进"
    },
    "source_refs": [{ "manuscript_id": "manuscript_xxx", "block_id": "block_hw_1", "range": null, "region": null }]
  }
]
```

The `asset_id` for a generated handwriting image may be a backend-created PNG asset, even if the source manuscript block only had strokes.

## Task Warnings

Conversion can succeed while individual blocks degrade. The client should inspect `task.result.warnings`.

Warning shape:

```json
{
  "block_id": "block_hw_1",
  "code": "handwriting_recognition_failed",
  "message": "手写识别失败，已保留手写图片。"
}
```

Relevant handwriting warning codes:

- `handwriting_empty`: the handwriting block had no strokes, no usable image, and no text fallback.
- `handwriting_render_failed`: the backend could not render or prepare a supported bitmap.
- `handwriting_recognition_failed`: bitmap rendering succeeded, but model recognition failed; the generated document keeps the handwriting image when possible.

Recommended UI behavior:

- Do not block opening the document when conversion succeeded with warnings.
- Show a small notice such as “部分手写内容已降级处理”.
- Optionally show warning details by source block.

## PC Client Checklist

- Include `optimize_audio` in `convert-manuscript` request body.
- Poll `GET /tasks/{task_id}` after the initial `202` response.
- Read `document_id` only from the completed task result.
- Do not rely on `handwriting.props.ai_text` being updated.
- Render document `image` blocks produced from handwriting the same way as normal document images.
- Display conversion warnings if present.

Known current adaptation points:

- `PC/src/lib/api.ts` should add `optimize_audio` to `convertManuscript`.
- `PC/src/lib/api.ts` should wait for the conversion task before reading `result.document_id`.

## Mobile Client Checklist

- Include `optimize_audio` in `convert-manuscript` request body.
- Continue flushing pending manuscript sync operations before conversion.
- Continue polling tasks and open `task.result.document_id` after success.
- Extend task result typing to include `warnings` and image-recognition fields if needed.
- Do not rely on `handwriting.props.ai_text` being updated.

Known current adaptation points:

- `mobile/src/lib/api.ts` should add `optimize_audio` to `convertManuscript`.
- `mobile/src/types/api.ts` should include `recognize_image` in `TaskType` if image-recognition tasks are used in UI.
- `mobile/src/types/api.ts` should include `warnings?: Array<{ block_id: string; code: string; message: string }>` in `Task.result`.

## Do Not Use `task.result.text` For Handwriting Convert

`task.result.text` belongs to generic image recognition or ASR-style task results. Handwriting conversion writes recognized text into generated `Document` blocks instead.

For manuscript conversion, the stable client contract is:

- `task.result.document_id` points to the generated document.
- `GET /documents/{document_id}` returns the recognized handwriting as `heading` or `paragraph` blocks.
- `task.result.warnings` reports any degraded handwriting handling.
