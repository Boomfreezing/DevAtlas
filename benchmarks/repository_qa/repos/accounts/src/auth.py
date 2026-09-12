from .models import find_user


def login_user(database, username, password):
    """Authenticate a user; return the persisted account identifier."""
    user = find_user(database, username)
    if user is None or not user.verify_password(password):
        raise ValueError("invalid credentials")
    return {"user_id": user.id}
