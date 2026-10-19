# Run ok computer on AWS

This runbook puts ok computer on one EC2 instance. The app runs in Docker. Tailscale makes the dashboard reachable from your own devices only. Litestream copies the database to S3 all the time, and Secrets Manager keeps the secrets. The instance has no open inbound port and no SSH key.

The first deploy takes about an hour. Run the `aws` commands on your own computer with an admin profile, unless a step says to run them on the instance.

In the commands, replace these words:

- `<region>`: for example `us-east-1`.
- `<account>`: the 12 digits of your AWS account.
- `<bucket>`: the name of the backup bucket, for example `okc-backup-<account>`.
- `<host>.<tailnet>.ts.net`: the Tailscale name of the server.

## 1. Overview and cost

| Part | What it does | About per month |
|---|---|---|
| EC2 `t4g.medium` (arm64, 2 vCPU, 4 GB), on demand | Runs the containers | $25 |
| EBS gp3, 30 GB | The root disk with the run folder | $2.40 |
| EBS snapshots, daily, 7 kept | Backup of the files that Litestream does not copy | $1 to $3 |
| S3 storage and requests | The Litestream copy of the database | $1 to $3 |
| Secrets Manager | $0.40 for each secret, plus $0.05 for each 10,000 calls. About 5 secrets. | $2 to $3 |
| Data transfer out | Model calls, Telegram and Google are small | $0 to $2 |
| **Total** | | **about $32 to $38** |

These are approximate prices of `us-east-1` in on-demand terms. Prices change and differ between regions, so check the AWS pricing pages. The model provider bills its API calls on its own. A one-year Compute Savings Plan or an EC2 Instance Savings Plan cuts the instance price by about a third once you know that you keep the server.

The S3 requests grow with the number of database writes. A busy agent writes more often, so look at the bill after the first month.

## 2. S3 bucket

1. Create the bucket in the region of the instance. In `us-east-1`, leave out `--create-bucket-configuration`.

   ```sh
   aws s3api create-bucket --bucket <bucket> --region <region> \
     --create-bucket-configuration LocationConstraint=<region>
   ```

2. Block all public access:

   ```sh
   aws s3api put-public-access-block --bucket <bucket> --public-access-block-configuration \
     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

3. Turn on versioning, so a deleted or overwritten backup file can come back:

   ```sh
   aws s3api put-bucket-versioning --bucket <bucket> --versioning-configuration Status=Enabled
   ```

4. Turn on SSE-S3 encryption:

   ```sh
   aws s3api put-bucket-encryption --bucket <bucket> --server-side-encryption-configuration \
     '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   ```

5. Add a lifecycle rule. Litestream deletes its own old files, and with versioning each deleted file stays as an old version. The rule removes old versions after 30 days:

   ```json
   {
     "Rules": [
       {
         "ID": "old-versions",
         "Status": "Enabled",
         "Filter": {},
         "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 },
         "Expiration": { "ExpiredObjectDeleteMarker": true }
       }
     ]
   }
   ```

   Save it as `lifecycle.json`, then:

   ```sh
   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json
   ```

## 3. Secrets Manager

Two kinds of secrets live here. Every name starts with `okc/`.

- `okc/env` holds the lines of `deploy/.env`. You write it. The first deploy reads it into `deploy/.env` with the `aws` command (section 7).
- `okc/google.client`, `okc/google.<alias>` and the other refs of the app. The app writes them itself, through the `aws` backend of the `secrets` block. You never write these by hand.

A ref with a character that a secret name cannot hold is written with `@` and two hex digits. For example the ref `linear:oauth-tokens` is the secret `okc/linear@3aoauth-tokens`.

1. Make a dashboard token:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Copy `deploy/env.example` to a file outside the repo, for example `env.server`, and fill it in:

   ```
   TS_AUTHKEY=tskey-auth-...
   OKC_RUN=/opt/okc/run
   OKC_BACKUP_BUCKET=<bucket>
   AWS_REGION=<region>
   ANTHROPIC_API_KEY=...
   DASHBOARD_TOKEN=<the 64 characters from step 1>
   ```

   Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` only if this server is the live Telegram host (section 10).

3. Store it, then delete the local file:

   ```sh
   aws secretsmanager create-secret --region <region> --name okc/env --secret-string file://env.server
   rm env.server
   ```

   To change it later, use `aws secretsmanager put-secret-value --secret-id okc/env --secret-string file://env.server`.

## 4. IAM role and instance profile

The instance gets one role. It can use the `okc/*` secrets and the backup bucket, and nothing else.

The role needs to write secrets too, not only read them:

- The token import (`npm run google:push`, section 11) stores `okc/google.<alias>`, and the client upload stores `okc/google.client`. The first write of a ref creates its secret.
- Google sometimes rotates a refresh token. The app then stores the new one at once, or the next start has a dead token.
- A delete of a ref deletes its secret at once, without a recovery window. A write to a secret that someone else marked for deletion restores it first.

1. Save the trust policy as `trust.json`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "Service": "ec2.amazonaws.com" },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   ```

2. Save the permissions as `okc-policy.json`. Replace `<region>`, `<account>` and `<bucket>`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "OkcSecrets",
         "Effect": "Allow",
         "Action": [
           "secretsmanager:GetSecretValue",
           "secretsmanager:PutSecretValue",
           "secretsmanager:CreateSecret",
           "secretsmanager:RestoreSecret",
           "secretsmanager:DeleteSecret"
         ],
         "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:okc/*"
       },
       {
         "Sid": "BackupBucketList",
         "Effect": "Allow",
         "Action": "s3:ListBucket",
         "Resource": "arn:aws:s3:::<bucket>"
       },
       {
         "Sid": "BackupBucketObjects",
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::<bucket>/*"
       }
     ]
   }
   ```

   The secrets use the default key of Secrets Manager, so the role needs no KMS permission.

3. Create the role and the instance profile:

   ```sh
   aws iam create-role --role-name okc --assume-role-policy-document file://trust.json
   aws iam put-role-policy --role-name okc --policy-name okc --policy-document file://okc-policy.json
   aws iam create-instance-profile --instance-profile-name okc
   aws iam add-role-to-instance-profile --instance-profile-name okc --role-name okc
   ```

Do not attach other policies to this role. Session Manager works without them (section 5, step 4).

## 5. EC2 instance

1. **Pick the image.** Ubuntu 24.04 arm64 is the simplest, because Docker's own packages include the compose and buildx plugins. Amazon Linux 2023 arm64 works too, but you install those two plugins by hand. Find the newest image:

   ```sh
   # ubuntu 24.04
   aws ssm get-parameter --region <region> --query Parameter.Value --output text \
     --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id
   # amazon linux 2023
   aws ssm get-parameter --region <region> --query Parameter.Value --output text \
     --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64
   ```

2. **Make a security group with no inbound rules.** A new group has none. Keep it that way. Tailscale connects outward, so nothing needs to come in.

   ```sh
   aws ec2 create-security-group --region <region> --group-name okc --description "ok computer, no inbound" --vpc-id <vpc>
   ```

3. **Start the instance.** The subnet must reach the internet, for example a public subnet of the default VPC. Use `/dev/sda1` for Ubuntu and `/dev/xvda` for Amazon Linux. There is no key pair.

   ```sh
   aws ec2 run-instances --region <region> \
     --image-id <ami> --instance-type t4g.medium \
     --subnet-id <subnet> --security-group-ids <sg> \
     --iam-instance-profile Name=okc \
     --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=2 \
     --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":false}}]' \
     --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=okc}]' 'ResourceType=volume,Tags=[{Key=okc-backup,Value=daily}]'
   ```

   - `HttpTokens=required` turns on IMDSv2 only.
   - `HttpPutResponseHopLimit=2`: the app and Litestream get the credentials of the role from the instance metadata service. A container sits one network hop behind the instance, so the answer of the metadata service must live for two hops. With the default of 1, the answer is dropped on the way, and the containers find no credentials.
   - `DeleteOnTermination=false` keeps the disk if the instance is terminated by mistake.
   - The `okc-backup` tag on the volume is for the daily snapshot (section 9).

4. **Use Session Manager instead of SSH.** In the Systems Manager console, open **Fleet Manager → Account management → Default Host Management Configuration** and turn it on for the region. Systems Manager then manages the instance through its own role, so the `okc` role stays as it is. Both images have the agent. Then connect:

   ```sh
   aws ssm start-session --region <region> --target <instance id>
   ```

   This needs the Session Manager plugin of the `aws` command on your computer.

5. **Install Docker and the AWS command** (on the instance). On Ubuntu 24.04, follow Docker's guide for its apt repository, then:

   ```sh
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
   sudo snap install aws-cli --classic
   sudo systemctl enable --now docker
   ```

   On Amazon Linux 2023, `sudo dnf install -y docker git`, then install the compose and buildx plugins from their release pages into `/usr/local/lib/docker/cli-plugins`. The `aws` command is already there.

   Check: `sudo docker compose version` prints a version.

## 6. Tailscale

1. In the Tailscale admin console, under **DNS**: turn on **MagicDNS** and **HTTPS Certificates**.
2. Under **Access controls**, add a tag for the server, for example `tag:okc`, with yourself as its owner. Make sure that your own devices may reach `tag:okc`.
3. Under **Settings → Keys**, generate an auth key. Make it **reusable**, give it the tag `tag:okc`, and do not make it ephemeral. A tagged machine does not expire. The key goes into `okc/env` as `TS_AUTHKEY` (section 3).
4. The `tailscale` service of `deploy/compose.yaml` runs `tailscale serve` to the dashboard port. It uses `serve`, never `funnel`. Funnel puts the dashboard on the public internet. Do not change that, and never add `ports:` to the compose file.
5. `DASHBOARD_TOKEN` must be set on the server (D11). The search pages return chat text, and the dashboard accepts the `ts.net` name only while the token is set.

## 7. First deploy

All of these steps run on the instance, in a Session Manager shell.

1. **Clone the repo:**

   ```sh
   sudo mkdir -p /opt/okc
   sudo git clone <repo url> /opt/okc/app
   ```

2. **Make the run folder.** The app runs as uid 10001 in the container, so that user must own it:

   ```sh
   sudo mkdir -p /opt/okc/run/data
   sudo chown -R 10001:10001 /opt/okc/run
   ```

   Do this before the first `docker compose up`. Otherwise Docker makes `data` as root, and both Litestream and the app fail. Do not make `workspace` or `skills` here: on the first start the container copies the workspace template only when `workspace` is missing.

3. **Write the config.** Start from the example:

   ```sh
   sudo cp /opt/okc/app/deploy/okc.config.example.json /opt/okc/run/okc.config.json
   sudoedit /opt/okc/run/okc.config.json
   ```

   It must hold at least:

   ```json
   {
     "secrets": { "backend": "aws", "region": "<region>" },
     "dashboard": { "publicUrl": "https://<host>.<tailnet>.ts.net" }
   }
   ```

   The prefix defaults to `okc/`. For a server without Secrets Manager, use `{ "backend": "file", "path": "data/secrets.json" }` instead; the file has mode 0600. Add the `google` block with the same `clientId` and accounts as on the desktop (see [google.md](google.md)). Put `okc.policy.json` and `okc.integrations.json` next to it if you use them. Then `sudo chown 10001:10001 /opt/okc/run/*.json`.

4. **Fetch `deploy/.env` from Secrets Manager.** The file is never committed:

   ```sh
   cd /opt/okc/app
   sudo sh -c 'umask 077; aws secretsmanager get-secret-value --region <region> --secret-id okc/env --query SecretString --output text > deploy/.env'
   sudo chmod 600 deploy/.env
   ```

5. **Start:**

   ```sh
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
   ```

   The services are `tailscale`, `restore`, `app` and `litestream`. `restore` runs once and stops. On a new host there is no backup yet, so it does nothing. There are no public ports.

6. **Check the services:**

   ```sh
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env ps
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env logs app
   ```

7. **Open the dashboard** from a device on the tailnet: `https://<host>.<tailnet>.ts.net`. On the login page, paste `DASHBOARD_TOKEN`.

8. **Upload the Google client.** On the server's **Google** page, use **Upload the client file** with the same `client_secret_….json` as on the desktop. The server now has `okc/google.client`.

9. **Send each Google account from the desktop.** See section 11.

10. **Check the secret store** from a device on the tailnet:

    ```sh
    curl -H "Authorization: Bearer <DASHBOARD_TOKEN>" https://<host>.<tailnet>.ts.net/api/secrets
    ```

    It shows the backend and whether it answers, never a value:

    ```json
    { "backend": "aws", "detail": "<region>, okc/", "ok": true, "error": null }
    ```

## 8. Updates

1. Pull and rebuild:

   ```sh
   cd /opt/okc/app
   sudo git pull
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
   ```

2. Check the logs for a clean start:

   ```sh
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env logs --since 10m app
   ```

3. To roll back, check out the last good commit and rebuild:

   ```sh
   sudo git log --oneline -5
   sudo git checkout <sha>
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
   ```

   If the update changed the database, the older code may not start on it. Then also restore the database to a time before the update (section 9, point in time). Run `sudo git switch master` before the next update.

After a change to `okc/env`, fetch `deploy/.env` again (section 7, step 4) and run the same `up -d` command. Compose restarts the services whose settings changed.

## 9. Backups and restore

**What is backed up.**

- Litestream copies `data/okc.sqlite` to the bucket within seconds of each write.
- Litestream covers only that file. `data/blobs`, `data/memory`, `workspace` and `skills` need the daily EBS snapshot below.
- The secrets stay in Secrets Manager. `okc.config.json` and the other config files are on the disk, so the snapshot has them too. Keep your own copy of `okc.config.json` as well.

**Daily EBS snapshot.** Data Lifecycle Manager snapshots each volume with the tag `okc-backup=daily` and keeps 7:

```sh
aws dlm create-default-role --region <region>
aws dlm create-lifecycle-policy --region <region> --description "okc daily" --state ENABLED \
  --execution-role-arn arn:aws:iam::<account>:role/AWSDataLifecycleManagerDefaultRole \
  --policy-details '{"ResourceTypes":["VOLUME"],"TargetTags":[{"Key":"okc-backup","Value":"daily"}],"Schedules":[{"Name":"daily","CreateRule":{"Interval":24,"IntervalUnit":"HOURS","Times":["09:00"]},"RetainRule":{"Count":7},"CopyTags":true}]}'
```

The time is UTC.

**The `restore` service.** Each `up` runs it first. It restores the database from the bucket only when `data/okc.sqlite` is missing. A host that has its database never gets it overwritten.

**Full restore to a new host.**

1. If the old host still runs, stop it: `sudo docker compose -f deploy/compose.yaml --env-file deploy/.env down`. Two hosts must never write to the same bucket path.
2. In the Tailscale admin console, remove the old machine, so the new one gets the same name and `dashboard.publicUrl` stays right.
3. Make the new instance (section 5) with the same role.
4. Do steps 1 to 4 of section 7. Keep `data/` empty.
5. Get the files from the newest snapshot. Make a volume from it in the zone of the instance, attach it, and copy:

   ```sh
   aws ec2 create-volume --region <region> --availability-zone <zone> --snapshot-id <snap> --volume-type gp3
   aws ec2 attach-volume --region <region> --volume-id <vol> --instance-id <instance id> --device /dev/sdf
   ```

   On the instance (the partition name differs; `lsblk` shows it):

   ```sh
   sudo mkdir -p /mnt/old && sudo mount -o ro /dev/nvme1n1p1 /mnt/old
   sudo rsync -a /mnt/old/opt/okc/run/data/blobs /mnt/old/opt/okc/run/data/memory /opt/okc/run/data/
   sudo rsync -a /mnt/old/opt/okc/run/workspace /mnt/old/opt/okc/run/skills /opt/okc/run/
   sudo cp /mnt/old/opt/okc/run/*.json /opt/okc/run/
   sudo chown -R 10001:10001 /opt/okc/run
   sudo umount /mnt/old
   ```

   Do not copy `data/okc.sqlite` from the snapshot. Litestream has a newer one. Detach and delete the volume afterwards.

6. Start with `up -d --build` (section 7, step 5). `restore` finds no database and restores the newest one from the bucket. The logs of `restore` say so.

The files of the snapshot can be up to a day older than the database. A blob or a memory file that the agent wrote in that day is then missing.

**Point-in-time restore**, for example after a bad update:

1. Stop the app and Litestream:

   ```sh
   cd /opt/okc/app
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env stop app litestream
   ```

2. Move the current database aside:

   ```sh
   sudo mkdir -p /opt/okc/run/data/before-restore
   sudo sh -c 'mv /opt/okc/run/data/okc.sqlite* /opt/okc/run/data/before-restore/'
   ```

3. Restore to a time in UTC:

   ```sh
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --no-deps litestream \
     restore -config /etc/litestream.yml -timestamp 2026-10-01T12:00:00Z /okc/data/okc.sqlite
   ```

4. Start again: `sudo docker compose -f deploy/compose.yaml --env-file deploy/.env up -d`. Delete `before-restore` once the app works.

## 10. Move the live Telegram role between hosts (D15)

Only one host has `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`. Every other copy, for example the desktop while the server is live, runs without them and uses web chat and the CLI.

Two hosts that poll the same bot make each other fail: Telegram gives each update to one poller only and refuses the other, so both miss messages and both log errors.

1. **Stop the old host's Telegram.**
   - On a desktop: delete the two lines from `.env`, then `okc restart`.
   - On a server: delete the two lines from `okc/env` and from `deploy/.env`, then `sudo docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --force-recreate app`.
2. **Check that it no longer polls.** The log of the start says `telegram is off, because TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID is not set`. On a server:

   ```sh
   sudo docker compose -f deploy/compose.yaml --env-file deploy/.env logs --since 5m app | grep telegram
   ```

3. **Set them on the new host.** On a server, add the two lines to `okc/env` with `put-secret-value`, fetch `deploy/.env` again (section 7, step 4). On a desktop, add them to `.env`.
4. **Restart the new host** (`up -d --force-recreate app`, or `okc restart`). The log says `telegram polling started`.
5. **Send a test message** to the bot. Only the new host answers.

## 11. Google on a server

The server cannot do the Google sign-in, because the answer of Google goes to a port on `127.0.0.1` of the machine that signed in. So you sign in on the desktop and send the refresh token to the server.

1. On the desktop, connect each account as in [google.md](google.md), section 3.
2. Make sure the server has the client: upload the client JSON on the server's **Google** page (section 7, step 8). The server keeps it as `okc/google.client`.
3. On the desktop, in the project folder, send each account. `OKC_REMOTE_TOKEN` is the `DASHBOARD_TOKEN` of the server, not of the desktop:

   ```sh
   OKC_REMOTE_TOKEN=<server DASHBOARD_TOKEN> npm run google:push -- personal --to https://<host>.<tailnet>.ts.net
   ```

   In PowerShell:

   ```powershell
   $env:OKC_REMOTE_TOKEN = "<server DASHBOARD_TOKEN>"; npm run google:push -- personal --to https://<host>.<tailnet>.ts.net
   ```

   The server refreshes the token once and runs the same checks as a sign-in: every permission must be there, and the address must match `email` of the alias. On a mismatch it stores nothing and revokes the token at Google. The client ID of the desktop must be the `clientId` of the server.

4. The server's Google page shows the account as signed in. Its next poll reads the mail.

**The same token now lives on two hosts.** Know what each action does:

- ok computer has no disconnect button. Deleting the entry `google.<alias>` from the credential store of the desktop removes only the desktop's copy. It does not tell Google, and the server keeps working.
- Removing the app at https://myaccount.google.com/permissions ends the access of the client for that account. The token of the server stops too.
- A refused sign-in or a refused import (a missing permission or the wrong address) revokes the token that it got. Google can end the other tokens of the same grant with it, so the server may then need a new push.
- A new **Connect** on the desktop makes a new refresh token. The server keeps its old one until you push again. Google keeps at most 100 tokens for one account and one client, and the oldest stop working after that.

**Once the server is live, remove the `google` block from the desktop's `okc.config.json`** and run `okc restart`. Otherwise both hosts poll the same mailbox, both make signals, and both tell you about the same mail. You can add the block again later to sign in for a new push.

## 12. Troubleshooting

| You see | Why | Fix |
|---|---|---|
| `GET /api/secrets` gives `"ok": false` | The app cannot reach Secrets Manager, or the role may not read `okc/*`. The `error` field says which. | Check the region in `okc.config.json`, the policy of section 4, and the hop limit below |
| The app log says that no AWS credentials were found, or a request to the metadata service timed out | The metadata hop limit is 1, so the containers get no answer | `aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-put-response-hop-limit 2`, then restart the services |
| `EACCES` or `permission denied` under `/okc` | The run folder is not owned by uid 10001 | `sudo chown -R 10001:10001 /opt/okc/run` |
| `another ok computer process runs on the data folder` | A second app uses the same `data/`: an old container, or a second compose project on the same run folder | `sudo docker ps`, stop the other one, then `up -d` again. Never point two hosts or two projects at one run folder |
| `restore` fails | The bucket name, the region or the S3 permission is wrong | Check `OKC_BACKUP_BUCKET` and `AWS_REGION` in `deploy/.env` and the policy of section 4 |
| The dashboard does not load | Tailscale is off on your device, or the `tailscale` service has not joined | `sudo docker compose -f deploy/compose.yaml --env-file deploy/.env logs tailscale`. An expired `TS_AUTHKEY` needs a new key in `okc/env` |
| `forbidden` on the dashboard | `dashboard.publicUrl` does not match the Tailscale name, or `DASHBOARD_TOKEN` is not set | Fix `okc.config.json` or `okc/env`, then restart the app |
| The bot answers twice or not at all, and the log shows Telegram errors | Two hosts poll the bot | Section 10 |
| `google:push` says that the client does not match | The desktop and the server have different `clientId` | Use the same client on both |
