FROM andrius/asterisk:alpine-20

USER root
RUN apk add --no-cache curl openssl jq bash

COPY config/pjsip.conf /etc/asterisk/pjsip.conf
COPY config/extensions.conf /etc/asterisk/extensions.conf
COPY config/ari.conf /etc/asterisk/ari.conf
COPY config/http.conf /etc/asterisk/http.conf
COPY agi/flowmind-callback.sh /usr/local/bin/flowmind-callback.sh

RUN chmod +x /usr/local/bin/flowmind-callback.sh \
    && mkdir -p /var/lib/asterisk/sounds/flowmind \
    && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk/sounds/flowmind

EXPOSE 5060/udp 5060/tcp 8088/tcp
CMD ["/usr/sbin/asterisk", "-f", "-vvv"]
