from fastapi import FastAPI, HTTPException

from .auth import login_user

app = FastAPI()


@app.post("/sessions")
def create_session(payload, database):
    try:
        return login_user(database, payload.username, payload.password)
    except ValueError as error:
        raise HTTPException(status_code=401, detail="invalid credentials") from error


@app.get("/health")
def health():
    return {"status": "ok"}
