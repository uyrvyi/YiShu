FROM python:3.13-slim@sha256:3dd7cc108ec1493442514f5c2a871af6af0ec31d768ff6e378a93340c3b3db5f
RUN apt-get update
RUN apt-get install -y --no-install-recommends libexpat1 osmium-tool tippecanoe
RUN pip install --no-cache-dir osmium==4.3.1 shapely==2.1.2 pyproj==3.7.2
WORKDIR /workspace
