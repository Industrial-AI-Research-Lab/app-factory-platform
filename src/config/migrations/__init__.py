"""Versioned migrations, one module each: ``m<NNNN>_<slug>.py``.

Declare ``VERSION`` (== NNNN), ``NAME``, ``async def up(ctx)``; optionally
``async def down(ctx)``, ``FATAL = True`` and ``CHECKSUM_INCLUDES`` (a tuple of
imported modules). Never edit a migration after it has been applied anywhere —
add a new version instead; the runner refuses to run on a checksum mismatch. The
checksum covers the module plus the modules in ``CHECKSUM_INCLUDES``; a helper
not listed there is not covered, so keep a migration's body in the module or
list the module where it lives — but not runtime modules the application shares,
or every runtime change trips the drift guard. See config/migration_runner.py
for the model.
"""
