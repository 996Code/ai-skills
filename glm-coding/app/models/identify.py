# -*- coding: utf-8 -*-
from pydantic import BaseModel
from typing import Optional


class IdentifyRequest(BaseModel):
    """验证码识别请求"""
    dataType: int = 1               # 1=URL, 2=base64
    imageSource: str = ""           # 图片 URL 或 base64
    imageID: Optional[str] = None   # 图片ID（透传）
    clickText: Optional[str] = None # 提示文字，如 "豹 雹 澄"
