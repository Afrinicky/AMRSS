from fastapi import APIRouter

from amrss.api.v1 import auth, interpretation

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(interpretation.router)
