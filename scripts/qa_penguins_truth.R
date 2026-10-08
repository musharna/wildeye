# Known answers for scripts/qa-penguins.mjs, read from the raw mapppdr v3.1 release with R itself.
#
# Usage: Rscript scripts/qa_penguins_truth.R <dir holding penguin_obs.rda, sites.rda> → JSON on stdout.
# (pipeline/penguins.py caches the files in $WILDEYE_CACHE/penguins/v3.1/data.)
#
# This never reads pipeline/penguins.py, pipeline/rda.py or public/data/penguins.json: R's own load() reads the
# release, and the rules below are written from the spec (docs/superpowers/specs/2026-10-07-penguins-design.md):
# a point is a site x species with a presence record; its latest counts are every record with a count in the
# latest season that has one, newest date first, undated last; a survey is a distinct (citekey, season, date,
# vantage); presence only means no count. The QA compares the card the browser shows with these answers.
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1) stop("usage: Rscript scripts/qa_penguins_truth.R <data dir>")
load(file.path(args[1], "penguin_obs.rda"))
load(file.path(args[1], "sites.rda"))
obs <- penguin_obs
obs$key <- paste(obs$site_id, obs$species_id)
present <- unique(obs$key[obs$presence == 1])
points <- obs[obs$key %in% present, ]

# Chosen colonies: a latest season whose newest count is chicks after a nests count (BREA gentoo); two nest counts on
# one day by two methods (BONG Adélie); adults and chicks of one emperor survey on different days (CROZ emperor); an
# undated nests + chicks survey (BART chinstrap); a latest count of 0 (ANCH Adélie); presence only (LAZN emperor); and
# every species at a four-species site (STRA), each with its own latest type.
chosen <- c("BREA GEPE", "BONG ADPE", "CROZ EMPE", "BART CHPE", "ANCH ADPE", "LAZN EMPE")
four <- names(which(tapply(points$species_id, points$site_id, function(v) length(unique(v))) == 4))
if (!("STRA" %in% four)) stop("STRA is no longer a four-species site: pick another")
chosen <- c(chosen, unique(points$key[points$site_id == "STRA"]))

answer <- function(k) {
  x <- points[points$key == k, ]
  s <- sites[sites$site_id == x$site_id[1], ]
  counted <- x[!is.na(x$count), ]
  latest <- NULL
  if (nrow(counted) > 0) {
    season <- max(counted$season)
    y <- counted[counted$season == season, ]
    y <- y[order(is.na(y$date), -as.numeric(y$date)), ]
    latest <- list(season = season, counts = lapply(seq_len(nrow(y)), function(i) list(
      type = y$type[i], count = y$count[i], date = if (is.na(y$date[i])) NULL else format(y$date[i]),
      accuracy = if (is.na(y$accuracy[i])) NULL else y$accuracy[i], vantage = if (is.na(y$vantage[i])) NULL else y$vantage[i])))
  }
  po <- x$season[is.na(x$count)]
  present_only <- if (length(po) && (is.null(latest) || max(po) > latest$season)) max(po) else NULL
  surveys <- nrow(unique(x[, c("citekey", "season", "date", "vantage")]))
  list(site = x$site_id[1], species = x$species_id[1], name = s$site_name, region = s$region, lat = s$latitude,
       lon = s$longitude, records = nrow(x), surveys = surveys, first = min(x$season), last = max(x$season),
       latest = latest, presentOnly = present_only,
       speciesHere = I(sort(unique(points$species_id[points$site_id == x$site_id[1]]))))
}
per_species <- as.list(table(unique(points[, c("site_id", "species_id")])$species_id))
out <- list(points = length(present), sites = length(unique(points$site_id)), perSpecies = per_species,
            colonies = lapply(chosen, answer))
cat(jsonlite::toJSON(out, auto_unbox = TRUE, null = "null", digits = NA))
