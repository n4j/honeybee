all: build push deploy ps

build:
	docker-compose build --pull

push:
	docker-compose push

stop:
	docker stack rm hb

deploy:
	docker stack deploy -c cluster.yml --with-registry-auth hb

logs:
	concurrently -n SCH,WRK -c blue,green "docker service logs -t -f --raw --tail=100 hb_scheduler | ruby -r 'date' -ne 'print \$$_.gsub(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/) { |time| DateTime.parse(time).new_offset(\"+9\").to_s }'" "docker service logs -t -f --no-trunc --no-task-ids --tail=100 hb_worker | ruby -r 'date' -ne 'print \$$_.gsub(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/) { |time| DateTime.parse(time).new_offset(\"+9\").to_s }'"

workerLogs:
	docker service logs -t --raw hb_worker 2>&1

ps:
	docker stack ps hb -f 'desired-state=running'

health:
	docker run --rm --network honeybee -it -e MONGO_URI=mongodb://${MONGO_WORKER_USERNAME}:${MONGO_WORKER_PASSWORD}@mongo/${MONGO_DATABASE} -e REDIS_URI=redis://:${REDIS_PASSWORD}@redis ${HONEYBEE_IMAGE} honeybee health

metrics:
	docker run --rm --network honeybee -it -e MONGO_URI=mongodb://${MONGO_WORKER_USERNAME}:${MONGO_WORKER_PASSWORD}@mongo/${MONGO_DATABASE} -e REDIS_URI=redis://:${REDIS_PASSWORD}@redis ${HONEYBEE_IMAGE} honeybee metrics

sh: build
	docker run --rm --network honeybee -it -e MONGO_URI=mongodb://${MONGO_WORKER_USERNAME}:${MONGO_WORKER_PASSWORD}@mongo/${MONGO_DATABASE} -e REDIS_URI=redis://:${REDIS_PASSWORD}@redis ${HONEYBEE_IMAGE} sh

logindb:
	docker exec -it $$(docker ps --filter name=hb_mongo --format '{{.Names}}') mongo -u ${MONGO_INITDB_ROOT_USERNAME} -p ${MONGO_INITDB_ROOT_PASSWORD} --authenticationDatabase admin ${MONGO_DATABASE}

showWaitingJobs:
	docker service logs -t --raw hb_scheduler|grep -E 'Waiting=[^0]'
