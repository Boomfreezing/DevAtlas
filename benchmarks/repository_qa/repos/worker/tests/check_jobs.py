from worker.jobs import process_export


def check_export_count(database):
    process_export(database, [{"id": 1}, {"id": 2}])
    assert database.last_parameters == {"count": 2}
