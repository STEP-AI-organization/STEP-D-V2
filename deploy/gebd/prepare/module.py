import os
import subprocess
from glob import glob
from extract_feature import *

def video_segmentation(video_path, temp_dir):
    
    video_name = os.path.basename(video_path)
    video_name, _ = os.path.splitext(video_name)
    video_name = video_name.strip()
    
    if os.path.isdir(temp_dir):
        pass
    else:
        os.makedirs(temp_dir, exist_ok = True)
        print(f"Create DIrectory : {temp_dir}")
    
    
    temp_video_name = os.path.join(temp_dir, f"{video_name}_%03d.mp4")
    temp_video_list_path = os.path.join(temp_dir, f"{video_name}.txt")
    
    # ⚠️ 원본은 `-c copy` 였다. 스트림 복사는 **키프레임에서만** 자를 수 있어서
    # `-segment_time 1` 이 1초를 보장하지 못한다. 이 마스터 파일들(적응형 GOP)에서
    # 실측 **0.3 세그먼트/초** — 60초 청크가 17.7행밖에 안 나왔다.
    # SJNET 은 TIME_UNIT=1 (1행=1초) 로 학습됐으므로 3.4배 빨리 감은 영상을 먹인 셈이고,
    # 경계 시각이 통째로 어긋났다.
    #
    # `-force_key_frames "expr:gte(t,n_forced*1)"` 로 **매 1초에 키프레임**을 박아
    # 세그먼터가 정확히 1초에서 자를 수 있게 한다. TSN 은 세그먼트당 3프레임(1x1x3)을
    # 224px 로 볼 뿐이라 화질은 무의미하다 — 256p·ultrafast·crf 30 으로 비용을 낮춘다.
    # 오디오/자막/타임코드는 feature 에 안 쓰이므로 전부 버린다(-an -sn -dn).
    #
    # ⚠️ `-g 1`(전 프레임 키프레임)로도 되지만 쓰지 말 것 — 프레임간 압축이 사라져
    # 세그먼트 용량이 **3.4배**가 된다(실측 1080p 30초분: 1.8MB vs 532KB). 이 단계의
    # 진짜 병목은 인코딩이 아니라 **TSN 의 CPU 측 디코딩**(GPU 사용률 9% · CPU 285%)이라,
    # 파일이 크면 그만큼 뒷단이 느려진다.
    # run_long_v3.sh 의 Stage A 가 이미 256p·매초 키프레임으로 정규화해 놓으면
    # **스트림 복사만으로 정확히 1초**가 나온다 (훨씬 빠르다). 그렇지 않은 입력을 위해
    # 복사 결과를 검증하고, 1행/초에 못 미치면 재인코딩으로 되돌린다.
    COPY_CMD = ('ffmpeg -i "{video_path}" -an -sn -dn -map 0:v:0 -c copy '
                '-segment_time 1 -f segment -reset_timestamps 1 "{video_split}" 2>&1')
    ENC_CMD = ('ffmpeg -i "{video_path}" -an -sn -dn -map 0:v:0 '
               '-vf scale=-2:256 -c:v libx264 -preset ultrafast -crf 30 '
               '-force_key_frames "expr:gte(t,n_forced*1)" '
               '-segment_time 1 -f segment -reset_timestamps 1 "{video_split}" 2>&1')

    def _probe_duration(path):
        try:
            out = subprocess.check_output(
                'ffprobe -v error -show_entries format=duration '
                '-of default=nw=1:nk=1 "%s"' % path, shell=True, encoding='utf-8')
            return float(out.strip())
        except Exception:
            return None

    def _run(cmd_format):
        cmd = cmd_format.format(video_path=video_path, video_split=temp_video_name)
        return subprocess.check_output(cmd, shell=True, encoding='utf-8')

    def _count(outputs):
        return sum(1 for o in outputs.split("Opening")[1:]
                   if o.split("'")[1].endswith('.mp4'))

    src_dur = _probe_duration(video_path)
    try:
        outputs = _run(COPY_CMD)
        n = _count(outputs)
        # 1행/초 미달이면 키프레임이 초 단위가 아니라는 뜻 → 재인코딩.
        # (원본 구현이 여기서 조용히 0.3행/초를 뱉어 경계 시각이 통째로 어긋났었다)
        if src_dur and n < 0.8 * src_dur:
            print(f'{video_path} : copy 분할이 {n}/{src_dur:.0f}초 → 재인코딩으로 전환')
            for old in glob(temp_video_name.replace('%03d', '*')):
                os.remove(old)
            outputs = _run(ENC_CMD)
    except subprocess.CalledProcessError as e:
        output = e.output
        if 'moov atom not found' in output:
            print(f'{video_path} : moov atom not found')
            return video_path, 'moov atom not found'
        elif 'Failed to open segment' in output:
            print(f'{video_path} : Failed to open segment')
            return video_path, 'Failed to open segment'
        else:
            print(f'{video_path} : other error')
            return video_path, 'other error'
    
    
    

    outputs = outputs.split("Opening")
    output_path = []
    with open(temp_video_list_path, "w") as f:
        for output in outputs[1:]:    
            path = output.split("'")[1]
            _, ext = os.path.splitext(path)
            if ext != '.mp4':
                continue
            output_path.append(path)
            f.write(f"{path}\n")
            
    return temp_video_list_path, output_path




def feature_extract(video_list_path, output_name, feature_type='tsn'):
    command_format = '{python} {script} {config} {checkpoint} --video-list {video_list} --out {output} 2>&1'

    output = f"{output_name}_{feature_type}.pkl"
    
    if os.path.isfile(output):
        """Avoid duplicate execution"""
        return output

    command = command_format.format(
        python=PYTHON_ENV,
        script=os.path.join(MMACTION_DIR, 'tools/misc/clip_feature_extraction.py'),
        config=CONFIG[feature_type],
        checkpoint=CHECKPOINT[feature_type],
        video_list=video_list_path,
        output=output
    )

    try:
        outputs = subprocess.check_output(command, shell=True, encoding='utf-8')
    except (subprocess.CalledProcessError) as e:
        print(e)
    
    return output


def delete_temporary_file(temp_video_list_path):
    
    command_format = 'xargs rm < {video_list}; rm {video_list}'
    command = command_format.format(
        video_list=temp_video_list_path,
    )
    outputs = subprocess.check_output(command, shell=True, encoding='utf-8')
    
    return outputs
