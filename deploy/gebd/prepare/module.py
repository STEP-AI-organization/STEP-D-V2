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
    
    command_format = 'ffmpeg -i "{video_path}" -c copy -map 0 -segment_time 1 -f segment -reset_timestamps 1 "{video_split}" 2>&1'
    command = command_format.format(
        video_path=video_path,
        video_split=temp_video_name
    )

    try:
        outputs = subprocess.check_output(command, shell=True, encoding='utf-8')
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
