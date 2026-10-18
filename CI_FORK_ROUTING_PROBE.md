# Temporary fork CI routing probe

This owned-fork branch verifies the unchanged upstream GitHub Actions workflow
on hosted Linux and native macOS runners. It adds no application or workflow
changes and must be closed without merging after routing verification.

Native source capture and upload must skip for this fork pull request. The Linux
build must wait for both platform test jobs. No Janus job, release or deployment
is requested.
