## Setup DigitalOcean instance

```bash
cd tf
terraform init -upgrade
terraform apply
```

## Setup Vultra instance

```bash
ufw allow ssh
ufw allow 2377
ufw allow 7946
ufw allow 7946/udp
ufw allow 4789/udp
ufw --force enable
apt-get install apt-transport-https ca-certificates curl gnupg lsb-release -y
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install docker-ce docker-ce-cli containerd.io -y
docker swarm join --token <join-token> --advertise-addr $(curl -q https://ifconfig.co) <master-ip>:2377
```
