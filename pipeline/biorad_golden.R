# Second engine for pipeline/vol2bird.py integration: run bioRad's own integrate_profile
# on the same vol2bird stdout profiles and write its numbers for the tests to compare against.
# Usage: Rscript pipeline/biorad_golden.R RADAR OUT_CSV PROFILE.txt [PROFILE.txt ...]
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 3) stop("usage: biorad_golden.R RADAR OUT_CSV PROFILE.txt ...")
suppressPackageStartupMessages(library(bioRad))
cat_file <- tempfile(fileext = ".txt")
writeLines(unlist(lapply(args[-(1:2)], readLines)), cat_file)
ts <- read_stdout(cat_file, radar = args[1], wavelength = "S")
# one profile: the vpts method takes a median of zero timesteps, so integrate the vp
vpi <- if (length(ts$datetime) == 1) integrate_profile(ts[1]) else integrate_profile(ts)
out <- data.frame(datetime = format(vpi$datetime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                  vid = sprintf("%.17g", vpi$vid), mtr = sprintf("%.17g", vpi$mtr),
                  mt = sprintf("%.17g", vpi$mt))
writeLines(c(paste0("# bioRad ", packageVersion("bioRad"), " integrate_profile defaults (alt_min 0, alt_max Inf, interval_max 3600)"),
             paste(names(out), collapse = ",")), args[2])
write.table(out, args[2], sep = ",", quote = FALSE, row.names = FALSE, col.names = FALSE, append = TRUE)
