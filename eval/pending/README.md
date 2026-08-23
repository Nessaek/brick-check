# Unlabelled pairs

Build/reference pairs that are known to be wrong but whose defect has not been
identified yet. They live here rather than in `cases/` because the harness
reads `"defects": []` as *"this build is correct"* — a known-wrong build
sitting in `cases/` with an empty defects list would score every correct
detection as a false positive and quietly drag the score down.

To promote one: work out where the real defect is, put it in `defects[]` as
x/y percentages of `build.jpg`, delete the `_todo` key, and move the directory
into `cases/`.
