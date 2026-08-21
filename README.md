# eliaseccli.com

Static personal site for Elias Eccli. Hosted on GitHub Pages (no WordPress, no Freehosting).

## Publish

1. Create a **public** GitHub repository and push this directory to the `main` branch.
2. In the repo: **Settings → Pages**
   - Source: Deploy from a branch
   - Branch: `main` / root (`/`)
3. Set the custom domain to `eliaseccli.com`. Enable HTTPS once DNS has propagated (GitHub issues the certificate after the `CNAME` file and A records resolve).

## DNS (GoDaddy)

Point the domain at GitHub Pages and **remove the Freehosting nameservers** so GoDaddy DNS is authoritative.

**A records** for `@` / `eliaseccli.com`:

| Type | Name | Value            |
|------|------|------------------|
| A    | @    | 185.199.108.153  |
| A    | @    | 185.199.109.153  |
| A    | @    | 185.199.110.153  |
| A    | @    | 185.199.111.153  |

**CNAME** for `www` → your GitHub Pages host:

| Type  | Name | Value            |
|-------|------|------------------|
| CNAME | www  | `USER.github.io` |

Replace `USER` with the GitHub username that owns the repository.

## Tesla map

`/teslastores` is a Voronoi map of current Tesla centers in Austria (OSM + Leaflet + d3-delaunay).

**Data sources**

- Tesla Austria service / center list
- WKO Wien — Shuttleworthstraße sales location
- WKO — Tesla Center Dornbirn

Coordinates geocoded with OpenStreetMap Nominatim.
