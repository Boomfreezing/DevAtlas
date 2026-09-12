from src.auth import login_user


def check_login_rejects_missing_user(database):
    try:
        login_user(database, "missing-user", "example-password")
    except ValueError as error:
        assert str(error) == "invalid credentials"
    else:
        raise AssertionError("expected invalid credentials")
