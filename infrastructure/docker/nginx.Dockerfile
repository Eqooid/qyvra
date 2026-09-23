FROM nginx:1.28-alpine
COPY infrastructure/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY infrastructure/nginx/19-upload-limit.envsh /docker-entrypoint.d/19-upload-limit.envsh
RUN chmod +x /docker-entrypoint.d/19-upload-limit.envsh
