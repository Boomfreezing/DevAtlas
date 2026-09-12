def find_user(database, username):
    """Load the account used by password authentication."""
    return database.execute(
        "SELECT id, password_hash FROM accounts WHERE username = :username",
        {"username": username},
    ).first()
