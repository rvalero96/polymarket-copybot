from fastapi import HTTPException, Security, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import CONFIG

_bearer = HTTPBearer()


def require_token(credentials: HTTPAuthorizationCredentials = Security(_bearer)) -> str:
    if credentials.credentials != CONFIG.api_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )
    return credentials.credentials
