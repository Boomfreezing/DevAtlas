from worker.runner import run_job

ROUTES = {"POST /exports": "submit_export"}


def submit_export(database, payload):
    return run_job(database, payload["records"])
