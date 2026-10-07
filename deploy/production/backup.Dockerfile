# syntax=docker/dockerfile:1
# Backup tools for production, built on the server by deploy.sh (nothing is installed on the
# host): PostgreSQL 16 client tools (the database's major version), rclone (object storage, with
# S3 Object Lock) and age (encryption). Pinned versions, checked by digest and checksum. amd64.
FROM rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5 AS rclone

FROM postgres:16-alpine
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
ADD --checksum=sha256:7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50 \
  https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz /tmp/age.tgz
RUN tar -xzf /tmp/age.tgz -C /usr/local/bin --strip-components=1 age/age age/age-keygen \
  && rm /tmp/age.tgz
COPY backup-job.sh /usr/local/bin/backup-job
USER postgres
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/backup-job"]
