# Second engine for pipeline/bird_nights.py night windows: bioRad's own sunset/sunrise
# (suntools crepuscule, sun 0.268 deg below the horizon) for every site on a few dates.
# Usage: Rscript pipeline/biorad_sun_golden.R pipeline/sites.json OUT_CSV YYYY-MM-DD [YYYY-MM-DD ...]
args <- commandArgs(trailingOnly = TRUE)
suppressPackageStartupMessages(library(bioRad))
sites <- jsonlite::fromJSON(args[1])
rows <- list()
for (d in args[-(1:2)]) {
  day <- as.POSIXct(d, tz = "UTC")
  for (i in seq_len(nrow(sites))) {
    s <- sites[i, ]
    rows[[length(rows) + 1]] <- data.frame(
      site = s$id, night = d,
      sunset = format(sunset(day, s$lon, s$lat), "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC"),
      sunrise = format(sunrise(day + 86400, s$lon, s$lat), "%Y-%m-%dT%H:%M:%OS3Z", tz = "UTC"))
  }
}
out <- do.call(rbind, rows)
writeLines(paste0("# bioRad ", packageVersion("bioRad"), " sunset(night)/sunrise(night + 1 day), elev -0.268"), args[2])
suppressWarnings(write.table(out, args[2], sep = ",", quote = FALSE, row.names = FALSE, append = TRUE))
