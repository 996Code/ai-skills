# -*- coding: utf-8 -*-
from fastapi import APIRouter
from app.models.identify import IdentifyRequest
from app.services.operation import run, run_show
from fastapi.responses import StreamingResponse

router = APIRouter()


@router.post("/identify")
async def identify(item: IdentifyRequest):
    """验证码识别接口"""
    try:
        result = await run(item)
        return {"code": 200, "msg": "成功", "data": result}
    except Exception as e:
        return {"code": 500, "msg": str(e), "data": None}


@router.post("/identify/show")
async def identify_show(item: IdentifyRequest):
    """验证码识别接口（返回标注图）"""
    try:
        img_bytes = await run_show(item)
        return StreamingResponse(img_bytes, media_type="image/jpeg")
    except Exception as e:
        return {"code": 500, "msg": str(e), "data": None}
